import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Provider from 'oidc-provider';
import { createHashedAdapter, openOAuthDatabase } from './adapter.js';

const scopes = ['mcp:content:read', 'mcp:content:write', 'mcp:redirects:read', 'mcp:redirects:write'];

export type SessionUser = { id: string; enabled: boolean; scopes: readonly string[] };
/** Bridge supplied by the private CMS process; this package provides no login route. */
export type SessionBridge = { resolve(request: IncomingMessage): Promise<SessionUser | undefined>; find(id: string): Promise<SessionUser | undefined> };
export type OAuthServiceOptions = { issuer: string; resource: string; databasePath: string; cookieKeys: readonly string[]; jwks: { keys: Array<Record<string, unknown>> }; sessionBridge?: SessionBridge };

const unavailableBridge: SessionBridge = { resolve: async () => undefined, find: async () => undefined };
type Interaction = { prompt: { name: string; details: { missingOIDCScope?: string[]; missingResourceScopes?: Record<string, string[]> } }; grantId?: string; session: { accountId: string }; params: { client_id: string } };
type Grant = { addResourceScope(resource: string, scope: string): void; addOIDCScope(scope: string): void; save(): Promise<string> };
type ProviderWithGrants = Provider & { Grant: { new (attributes: { accountId: string; clientId: string }): Grant; find(id: string): Promise<Grant | undefined> } };
type PendingInteraction = { csrf: string; accountId: string };
const json = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
const invalidRequest = (response: ServerResponse, description: string) => json(response, 400, { error: 'invalid_request', error_description: description });

function exactResource(resource: string, candidate: unknown): boolean {
  return typeof candidate === 'string' && candidate === resource;
}

function validRedirect(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const url = URL.parse(value);
  if (!url || url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  if (request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(body));
  }
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('registration body must be an object');
  return value as Record<string, unknown>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 16_384) throw new Error('registration request is too large');
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function tokenForm(request: IncomingMessage, resource: string): Promise<Record<string, string>> {
  if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new Error('token requests must be urlencoded');
  const params = new URLSearchParams(await readBody(request));
  const values = new Map<string, string[]>();
  for (const [key, value] of params) values.set(key, [...(values.get(key) ?? []), value]);
  if ([...values.values()].some((entries) => entries.length !== 1)) throw new Error('duplicate token parameter');
  if (values.get('resource')?.[0] !== resource) throw new Error('an exact resource indicator is required');
  return Object.fromEntries([...values].map(([key, entries]) => [key, entries[0]!])) as Record<string, string>;
}

function registrationMetadata(body: Record<string, unknown>, resource: string): Record<string, unknown> {
  const allowed = new Set(['client_name', 'redirect_uris', 'grant_types', 'response_types', 'token_endpoint_auth_method', 'scope']);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error('unsupported client metadata');
  if (body.token_endpoint_auth_method !== 'none') throw new Error('only public clients are supported');
  const redirects = body.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0 || !redirects.every(validRedirect)) throw new Error('redirect URIs must be HTTPS or loopback HTTP');
  const grants = body.grant_types ?? ['authorization_code'];
  if (!Array.isArray(grants) || grants.some((grant) => grant !== 'authorization_code' && grant !== 'refresh_token') || !grants.includes('authorization_code')) throw new Error('unsupported grant type');
  const responses = body.response_types ?? ['code'];
  if (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== 'code') throw new Error('only code response type is supported');
  const requestedScopes = typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [];
  if (requestedScopes.some((scope) => ![...scopes, 'offline_access'].includes(scope))) throw new Error('unsupported scope');
  return { client_id: randomUUID(), client_name: body.client_name, redirect_uris: redirects, grant_types: grants, response_types: responses, token_endpoint_auth_method: 'none', scope: requestedScopes.join(' '), application_type: 'native' };
}

export function createOAuthService(options: OAuthServiceOptions): { server: Server; provider: Provider; close(): void } {
  const issuer = new URL(options.issuer);
  const prefix = issuer.pathname.replace(/\/$/, '');
  const resource = new URL(options.resource);
  const loopback = issuer.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(issuer.hostname);
  if (!prefix || issuer.origin === 'null' || resource.origin !== issuer.origin || (!loopback && (issuer.protocol !== 'https:' || resource.protocol !== 'https:'))) {
    throw new Error('issuer and resource must share an HTTPS origin (loopback HTTP is test-only)');
  }
  mkdirSync(dirname(options.databasePath), { recursive: true });
  const db = openOAuthDatabase(options.databasePath);
  const bridge = options.sessionBridge ?? unavailableBridge;
  const pendingInteractions = new Map<string, PendingInteraction>();
  const provider = new Provider(options.issuer, {
    adapter: createHashedAdapter(db),
    clients: [],
    jwks: options.jwks,
    cookies: { keys: [...options.cookieKeys] },
    scopes: [...scopes, 'offline_access'],
    responseTypes: ['code'],
    pkce: { required: () => true },
    issueRefreshToken: async () => true,
    ttl: {
      Interaction: () => 600,
      Session: () => 1_209_600,
      Grant: () => 1_209_600,
      AuthorizationCode: () => 60,
      AccessToken: () => 900,
      RefreshToken: () => 2_592_000,
    },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true, issueRegistrationAccessToken: false },
      registrationManagement: { enabled: false },
      clientCredentials: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => undefined,
        useGrantedResource: async () => false,
        getResourceServerInfo: async (_ctx: unknown, resource: string) => {
          if (resource !== options.resource) throw new Error('invalid resource indicator');
          return { audience: options.resource, scope: [...scopes, 'offline_access'].join(' '), accessTokenFormat: 'opaque' };
        },
      },
    },
    findAccount: async (_ctx: unknown, id: string) => {
      const user = await bridge.find(id);
      if (!user?.enabled) return undefined;
      return { accountId: user.id, claims: async () => ({ sub: user.id }) };
    },
    interactions: { url: async (_ctx: unknown, interaction: { jti: string }) => `${prefix}/interaction/${interaction.jti}` },
  });
  const callback = provider.callback();
  const authorizationMetadata = {
    issuer: options.issuer,
    authorization_endpoint: `${options.issuer}/auth`,
    token_endpoint: `${options.issuer}/token`,
    registration_endpoint: `${options.issuer}/reg`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...scopes, 'offline_access'],
  };

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', issuer.origin);
    if (requestUrl.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(response, 200, { resource: options.resource, authorization_servers: [options.issuer], scopes_supported: scopes });
    }
    if (requestUrl.pathname === `${prefix}/.well-known/openid-configuration` || requestUrl.pathname === `/.well-known/oauth-authorization-server${prefix}`) {
      return json(response, 200, authorizationMetadata);
    }
    if (requestUrl.pathname === `${prefix}/reg` && request.method === 'POST') {
      try {
        const metadata = registrationMetadata(await requestJson(request), options.resource);
        const client = new provider.Client(metadata);
        await provider.Client.adapter.upsert(client.clientId, client.metadata());
        return json(response, 201, client.metadata());
      } catch {
        return json(response, 400, { error: 'invalid_client_metadata' });
      }
    }
    if (requestUrl.pathname === `${prefix}/reg` || requestUrl.pathname.startsWith(`${prefix}/reg/`)) return json(response, 405, { error: 'method_not_allowed' });
    if (requestUrl.pathname === `${prefix}/auth` && !exactResource(options.resource, requestUrl.searchParams.get('resource'))) {
      return invalidRequest(response, 'an exact resource indicator is required');
    }
    if (requestUrl.pathname === `${prefix}/token`) {
      if (request.method !== 'POST') return json(response, 405, { error: 'method_not_allowed' });
      try {
        // oidc-provider's documented body-parser fallback consumes req.body when an
        // upstream middleware has already parsed the stream. We validate that one
        // bounded form first, then pass the same values through without replaying.
        (request as IncomingMessage & { body?: Record<string, string> }).body = await tokenForm(request, options.resource);
      } catch {
        return invalidRequest(response, 'an exact, non-duplicated resource indicator is required');
      }
    }
    if (requestUrl.pathname.startsWith(`${prefix}/interaction/`)) {
      if (request.method !== 'GET' && request.method !== 'POST') return json(response, 405, { error: 'method_not_allowed' });
      const user = await bridge.resolve(request);
      if (!user?.enabled) return json(response, 401, { error: 'login_required' });
      try {
        const interaction = await provider.interactionDetails(request, response) as unknown as Interaction;
        const jti = requestUrl.pathname.slice(`${prefix}/interaction/`.length);
        if (request.method === 'GET') {
          const csrf = randomUUID();
          pendingInteractions.set(jti, { csrf, accountId: user.id });
          const requested = [
            ...(interaction.prompt.details.missingOIDCScope ?? []),
            ...Object.values(interaction.prompt.details.missingResourceScopes ?? {}).flat(),
          ].filter((scope, index, all) => all.indexOf(scope) === index).map(escapeHtml).join(', ');
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
          response.end(`<!doctype html><title>Authorize access</title><main><h1>Authorize access</h1><p>Client: ${escapeHtml(interaction.params.client_id)}</p><p>Requested access: ${requested || 'sign in'}</p><form method="post" action="${escapeHtml(requestUrl.pathname)}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="deny">Deny</button></form></main>`);
          return;
        }
        if (request.headers.origin !== issuer.origin) return invalidRequest(response, 'same-origin form submission required');
        const form = await requestJson(request);
        const pending = pendingInteractions.get(jti);
        pendingInteractions.delete(jti);
        if (!pending || pending.csrf !== form.csrf || pending.accountId !== user.id) return invalidRequest(response, 'invalid interaction confirmation');
        if (form.decision !== 'allow' && form.decision !== 'deny') return invalidRequest(response, 'invalid interaction decision');
        if (form.decision === 'deny') return provider.interactionFinished(request, response, { error: 'access_denied', error_description: 'resource owner denied access' });
        if (interaction.prompt.name === 'consent' && interaction.session.accountId !== user.id) return invalidRequest(response, 'session account does not match current user');
        let result: Record<string, unknown>;
        if (interaction.prompt.name === 'login') {
          result = { login: { accountId: user.id } };
        } else {
          const grants = provider as ProviderWithGrants;
          const grant = interaction.grantId ? await grants.Grant.find(interaction.grantId) : new grants.Grant({ accountId: interaction.session.accountId, clientId: interaction.params.client_id });
          if (!grant) throw new Error('grant not found');
          if (interaction.prompt.details.missingOIDCScope?.length) grant.addOIDCScope(interaction.prompt.details.missingOIDCScope.join(' '));
          for (const [indicator, requestedScopes] of Object.entries(interaction.prompt.details.missingResourceScopes ?? {})) {
            const grantedScopes = requestedScopes.filter((scope) => scope === 'offline_access' || user.scopes.includes(scope));
            grant.addResourceScope(indicator, grantedScopes.join(' '));
          }
          result = { consent: { grantId: await grant.save() } };
        }
        return provider.interactionFinished(request, response, result);
      } catch {
        return json(response, 400, { error: 'invalid_interaction' });
      }
    }
    if (requestUrl.pathname.startsWith(`${prefix}/`)) {
      // oidc-provider's documented mounted-app support derives the mount from
      // originalUrl. Keeping both values lets every generated endpoint retain /oauth.
      (request as IncomingMessage & { originalUrl?: string }).originalUrl = `${requestUrl.pathname}${requestUrl.search}`;
      request.url = `${requestUrl.pathname.slice(prefix.length)}${requestUrl.search}` || '/';
      return callback(request, response);
    }
    return json(response, 404, { error: 'not_found' });
  });
  return { server, provider, close: () => db.close() };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.PORT ?? '3001');
  const issuer = process.env.OAUTH_ISSUER;
  const resource = process.env.OAUTH_RESOURCE;
  const databasePath = process.env.OAUTH_DATABASE_PATH;
  const cookieKeys = process.env.OAUTH_COOKIE_KEYS?.split(',').filter(Boolean) ?? [];
  const jwks = process.env.OAUTH_JWKS ? JSON.parse(process.env.OAUTH_JWKS) as { keys: Array<Record<string, unknown>> } : undefined;
  if (!issuer || !resource || !databasePath || cookieKeys.length < 2 || !jwks) throw new Error('OAUTH_ISSUER, OAUTH_RESOURCE, OAUTH_DATABASE_PATH, OAUTH_JWKS, and two OAUTH_COOKIE_KEYS are required');
  const service = createOAuthService({ issuer, resource, databasePath, cookieKeys, jwks });
  service.server.listen(port);
}
