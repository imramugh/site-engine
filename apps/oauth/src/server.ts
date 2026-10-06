import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Provider from 'oidc-provider';
import { createHashedAdapter, findGrantBinding, listManagedGrants, openOAuthDatabase, revokeGrantFamily, revokeManagedGrant, storeGrantBinding, touchManagedGrant } from './adapter.js';
import { createHttpSessionBridge } from './session-bridge.js';

const scopes = ['mcp:content:read', 'mcp:content:write', 'mcp:redirects:read', 'mcp:redirects:write', 'mcp:leads:read', 'mcp:careers:read'];

export type SessionUser = { id: string; enabled: boolean; scopes: readonly string[]; sessionId?: string };
/** Bridge supplied by the private CMS process; this package provides no login route. */
export type SessionBridge = { resolve(request: IncomingMessage): Promise<SessionUser | undefined>; find(id: string, sessionId?: string): Promise<SessionUser | undefined> };
export type RegistrationFailureReason = 'invalid_request' | 'public_client_required' | 'invalid_redirect_uri' | 'application_type_mismatch' | 'unsupported_grant_type' | 'unsupported_response_type' | 'unsupported_scope' | 'provider_rejected_metadata';
export type OAuthServiceOptions = { issuer: string; resource: string; databasePath: string; cookieKeys: readonly string[]; jwks: { keys: Array<Record<string, unknown>> }; sessionBridge?: SessionBridge; trustProxy?: boolean; onRegistrationFailure?: (reason: RegistrationFailureReason) => void };

const unavailableBridge: SessionBridge = { resolve: async () => undefined, find: async () => undefined };
class SessionBridgeUnavailable extends Error {}
type Interaction = { prompt: { name: string; details: { missingOIDCScope?: string[]; missingResourceScopes?: Record<string, string[]> } }; grantId?: string; session: { accountId: string }; params: { client_id: string } };
type Grant = { addResourceScope(resource: string, scope: string): void; addOIDCScope(scope: string): void; save(): Promise<string> };
type ProviderWithGrants = Provider & { Grant: { new (attributes: { accountId: string; clientId: string }): Grant; find(id: string): Promise<Grant | undefined> }; Client: { find(id: string): Promise<{ clientName?: string } | undefined> } };
type PendingInteraction = { csrf: string; accountId: string; sessionId: string; expiresAt: number };
type TokenRecord = { grantId?: string; accountId?: string; clientId?: string; resource?: string; scope?: string; exp?: number; aud?: string | string[] };
const pendingInteractionLimit = 500;
const pendingInteractionTtl = 10 * 60 * 1000;
const json = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
const invalidRequest = (response: ServerResponse, description: string) => json(response, 400, { error: 'invalid_request', error_description: description });

function exactResource(resource: string, candidate: unknown): boolean {
  return typeof candidate === 'string' && candidate === resource;
}

function validRedirect(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const url = URL.parse(value);
  if (!url || url.hash || url.username || url.password || value.includes('*')) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
}

function loopbackRedirect(value: string): boolean {
  const url = URL.parse(value);
  return url?.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
}

class RegistrationMetadataError extends Error {
  constructor(readonly reason: RegistrationFailureReason) { super(reason); }
}

function secretMatches(value: string | undefined, expected: string | undefined): boolean {
  if (!value || !expected) return false;
  const left = Buffer.from(value); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function grantedScopes(value: string | undefined): string[] {
  return (value ?? '').split(' ').filter((scope, index, all) => scopes.includes(scope) && all.indexOf(scope) === index);
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
  // Only the metadata below affects authorization. Unknown RFC 7591 metadata
  // is ignored and never retained or fetched.
  if (body.token_endpoint_auth_method !== 'none') throw new RegistrationMetadataError('public_client_required');
  const redirects = body.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0 || !redirects.every(validRedirect)) throw new RegistrationMetadataError('invalid_redirect_uri');
  const hasLoopbackRedirect = redirects.some(loopbackRedirect);
  const requestedApplicationType = body.application_type;
  if (requestedApplicationType !== undefined && requestedApplicationType !== 'native' && requestedApplicationType !== 'web') throw new RegistrationMetadataError('application_type_mismatch');
  if (requestedApplicationType === 'web' && hasLoopbackRedirect) throw new RegistrationMetadataError('application_type_mismatch');
  const applicationType = requestedApplicationType ?? (hasLoopbackRedirect ? 'native' : 'web');
  const grants = body.grant_types ?? ['authorization_code'];
  if (!Array.isArray(grants) || grants.some((grant) => grant !== 'authorization_code' && grant !== 'refresh_token') || !grants.includes('authorization_code')) throw new RegistrationMetadataError('unsupported_grant_type');
  const responses = body.response_types ?? ['code'];
  if (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== 'code') throw new RegistrationMetadataError('unsupported_response_type');
  if (body.scope !== undefined && typeof body.scope !== 'string') throw new RegistrationMetadataError('unsupported_scope');
  const requestedScopes = typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [];
  if (requestedScopes.some((scope) => ![...scopes, 'offline_access'].includes(scope))) throw new RegistrationMetadataError('unsupported_scope');
  // An omitted scope must not turn into an unrestricted client allow-list.
  const effectiveScopes = requestedScopes.length ? requestedScopes : [scopes[0]!];
  return { client_id: randomUUID(), client_name: body.client_name, redirect_uris: redirects, grant_types: grants, response_types: responses, token_endpoint_auth_method: 'none', scope: effectiveScopes.join(' '), application_type: applicationType };
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
  const validatedTokenRequests = new WeakMap<IncomingMessage, SessionUser>();
  const revokeInvalidBinding = async (record: TokenRecord) => {
    if (!record.grantId) return;
    try { revokeGrantFamily(db, record.grantId, 'oauth.grant_binding_revoked'); } catch { /* fail closed below */ }
  };
  const currentBinding = async (record: TokenRecord, clientId: string, resource: string) => {
    if (!record.grantId || !record.accountId || record.clientId !== clientId) return undefined;
    const binding = findGrantBinding(db, record.grantId);
    if (!binding || binding.userId !== record.accountId || binding.clientId !== clientId || binding.resource !== resource || (record.resource !== undefined && record.resource !== resource)) return undefined;
    // Authorization codes carry OIDC scope separately from resource scopes;
    // access/refresh records carry the effective resource scope. The binding's
    // exact resource is still mandatory for every record.
    if (record.scope !== undefined && record.scope.includes('mcp:') && !binding.scopes.every((scope) => grantedScopes(record.scope).includes(scope))) return undefined;
    let user: SessionUser | undefined;
    try { user = await bridge.find(binding.userId, binding.sessionId); } catch { return undefined; }
    if (!user?.enabled || user.id !== binding.userId || user.sessionId !== binding.sessionId) return undefined;
    touchManagedGrant(db, record.grantId);
    return { binding, user };
  };
  const activeManagedGrants = async (userId?: string) => {
    const active = [];
    for (const binding of listManagedGrants(db, userId)) {
      let user: SessionUser | undefined;
      try { user = await bridge.find(binding.userId, binding.sessionId); } catch { throw new SessionBridgeUnavailable(); }
      if (!user || !user.enabled || user.id !== binding.userId || user.sessionId !== binding.sessionId || !binding.scopes.every((scope) => user.scopes.includes(scope))) continue;
      active.push(binding);
    }
    return active;
  };
  const lookupToken = async (model: 'AuthorizationCode' | 'RefreshToken' | 'AccessToken', value: string): Promise<TokenRecord | undefined> => {
    try { return await (provider as unknown as Record<string, { find(id: string): Promise<TokenRecord | undefined> }>)[model].find(value); } catch { return undefined; }
  };
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
    findAccount: async (ctx: unknown, id: string) => {
      // OIDC only supplies accountId here. Resolve the actual CMS cookie from
      // this request; never select an arbitrary active CMS session by user id.
      const request = (ctx as { req: IncomingMessage }).req;
      let user = validatedTokenRequests.get(request);
      if (!user) {
        try { user = await bridge.resolve(request); } catch { return undefined; }
      }
      if (!user?.enabled || user.id !== id || !user.sessionId) return undefined;
      return { accountId: user.id, claims: async () => ({ sub: user.id }) };
    },
    interactions: { url: async (_ctx: unknown, interaction: { jti: string }) => `${prefix}/interaction/${interaction.jti}` },
  });
  // The public issuer may be HTTPS while this private service receives HTTP
  // only from an edge that overwrites forwarded headers. Keep this opt-in so
  // direct deployments never trust caller-supplied X-Forwarded-* headers.
  (provider as Provider & { proxy: boolean }).proxy = options.trustProxy === true;
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
    if (requestUrl.pathname === '/internal/grants') {
      const suppliedSecret = request.headers['x-oauth-introspection-secret'];
      if (request.method !== 'POST' || !secretMatches(typeof suppliedSecret === 'string' ? suppliedSecret : undefined, process.env.OAUTH_INTROSPECTION_SECRET)) return json(response, 401, { error: 'unauthorized' });
      try {
        const body = await requestJson(request); const keys = Object.keys(body);
        if (body.operation === 'list' && keys.every((key) => key === 'operation' || key === 'userId') && (body.userId === undefined || typeof body.userId === 'string')) return json(response, 200, { grants: (await activeManagedGrants(body.userId as string | undefined)).map(({ sessionId: _sessionId, ...grant }) => grant) });
        if (body.operation === 'revoke' && keys.every((key) => key === 'operation' || key === 'managementId' || key === 'userId') && typeof body.managementId === 'string' && (body.userId === undefined || typeof body.userId === 'string')) return revokeManagedGrant(db, body.managementId, body.userId as string | undefined) ? json(response, 200, { revoked: true }) : json(response, 404, { error: 'not_found' });
        throw new Error('invalid');
      } catch (error) { return error instanceof SessionBridgeUnavailable ? json(response, 503, { error: 'session_bridge_unavailable' }) : json(response, 400, { error: 'invalid_request' }); }
    }
    if (requestUrl.pathname === '/internal/introspect') {
      const suppliedSecret = request.headers['x-oauth-introspection-secret'];
      if (request.method !== 'POST' || !secretMatches(typeof suppliedSecret === 'string' ? suppliedSecret : undefined, process.env.OAUTH_INTROSPECTION_SECRET)) return json(response, 401, { error: 'unauthorized' });
      try {
        const body = await requestJson(request);
        const keys = Object.keys(body);
        if (!keys.every((key) => key === 'token' || key === 'resource' || key === 'clientId') || (keys.length !== 2 && keys.length !== 3) || typeof body.token !== 'string' || body.resource !== options.resource || (body.clientId !== undefined && typeof body.clientId !== 'string')) throw new Error('invalid');
        const token = await lookupToken('AccessToken', body.token);
        const current = token?.clientId ? await currentBinding(token, token.clientId, body.resource) : undefined;
        const tokenScopes = grantedScopes(token?.scope);
        const effectiveScopes = current ? tokenScopes.filter((scope) => current.binding.scopes.includes(scope) && current.user.scopes.includes(scope)) : [];
        const scopeLost = Boolean(current && !current.binding.scopes.every((scope) => current.user.scopes.includes(scope)));
        if (!token || !current || scopeLost || !effectiveScopes.length || token.aud !== options.resource || (body.clientId !== undefined && body.clientId !== current.binding.clientId)) { if (token && (!current || scopeLost)) await revokeInvalidBinding(token); return json(response, 200, { active: false }); }
        return json(response, 200, { active: true, clientId: current.binding.clientId, resource: current.binding.resource, scopes: effectiveScopes, userId: current.binding.userId, sessionId: current.binding.sessionId, expiresAt: token.exp ?? Math.floor(current.binding.expiresAt / 1000) });
      } catch { return json(response, 200, { active: false }); }
    }
    if (requestUrl.pathname === `${prefix}/.well-known/openid-configuration` || requestUrl.pathname === `/.well-known/oauth-authorization-server${prefix}`) {
      return json(response, 200, authorizationMetadata);
    }
    if (requestUrl.pathname === `${prefix}/reg` && request.method === 'POST') {
      let metadata: Record<string, unknown>;
      try {
        metadata = registrationMetadata(await requestJson(request), options.resource);
      } catch (error) {
        const reason: RegistrationFailureReason = error instanceof RegistrationMetadataError ? error.reason : 'invalid_request';
        try { options.onRegistrationFailure?.(reason); } catch { /* diagnostics must not affect registration */ }
        return json(response, 400, { error: 'invalid_client_metadata' });
      }
      try {
        const client = new provider.Client(metadata);
        await provider.Client.adapter.upsert(client.clientId, client.metadata());
        return json(response, 201, client.metadata());
      } catch {
        try { options.onRegistrationFailure?.('provider_rejected_metadata'); } catch { /* diagnostics must not affect registration */ }
        return json(response, 400, { error: 'invalid_client_metadata' });
      }
    }
    if (requestUrl.pathname === `${prefix}/reg` || requestUrl.pathname.startsWith(`${prefix}/reg/`)) return json(response, 405, { error: 'method_not_allowed' });
    if (requestUrl.pathname === `${prefix}/auth` && !exactResource(options.resource, requestUrl.searchParams.get('resource'))) {
      return invalidRequest(response, 'an exact resource indicator is required');
    }
    if (requestUrl.pathname === `${prefix}/auth`) {
      let sessionUser: SessionUser | undefined;
      try { sessionUser = await bridge.resolve(request); } catch { sessionUser = undefined; }
      if (sessionUser && !sessionUser.enabled) return json(response, 401, { error: 'login_required' });
    }
    if (requestUrl.pathname === `${prefix}/token`) {
      if (request.method !== 'POST') return json(response, 405, { error: 'method_not_allowed' });
      try {
        // oidc-provider's documented body-parser fallback consumes req.body when an
        // upstream middleware has already parsed the stream. We validate that one
        // bounded form first, then pass the same values through without replaying.
        const form = await tokenForm(request, options.resource);
        const rawToken = form.grant_type === 'authorization_code' ? form.code : form.grant_type === 'refresh_token' ? form.refresh_token : undefined;
        const model = form.grant_type === 'authorization_code' ? 'AuthorizationCode' : form.grant_type === 'refresh_token' ? 'RefreshToken' : undefined;
        const token = rawToken && model ? await lookupToken(model, rawToken) : undefined;
        // Let oidc-provider return its standard client-authentication response
        // for a token presented by a different client. For the owning client,
        // a fresh CMS binding is mandatory before exchanging either credential.
        if (token?.clientId === form.client_id) {
          const current = await currentBinding(token, form.client_id, options.resource);
          if (!current || !current.binding.scopes.every((scope) => current.user.scopes.includes(scope))) { await revokeInvalidBinding(token); return json(response, 400, { error: 'invalid_grant' }); }
          validatedTokenRequests.set(request, current.user);
        }
        (request as IncomingMessage & { body?: Record<string, string> }).body = form;
      } catch {
        return invalidRequest(response, 'an exact, non-duplicated resource indicator is required');
      }
    }
    if (requestUrl.pathname.startsWith(`${prefix}/interaction/`)) {
      if (request.method !== 'GET' && request.method !== 'POST') return json(response, 405, { error: 'method_not_allowed' });
      let user: SessionUser | undefined;
      try { user = await bridge.resolve(request); } catch { user = undefined; }
      if (!user?.enabled) return json(response, 401, { error: 'login_required' });
      try {
        const interaction = await provider.interactionDetails(request, response) as unknown as Interaction;
        const jti = requestUrl.pathname.slice(`${prefix}/interaction/`.length);
        for (const [key, pending] of pendingInteractions) if (pending.expiresAt <= Date.now()) pendingInteractions.delete(key);
        if (request.method === 'GET') {
          if (pendingInteractions.size >= pendingInteractionLimit) return json(response, 429, { error: 'interaction_capacity' });
          const csrf = randomUUID();
          if (!user.sessionId) return json(response, 401, { error: 'login_required' });
          pendingInteractions.set(jti, { csrf, accountId: user.id, sessionId: user.sessionId, expiresAt: Date.now() + pendingInteractionTtl });
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
        if (!pending || pending.expiresAt <= Date.now() || pending.csrf !== form.csrf || pending.accountId !== user.id || pending.sessionId !== user.sessionId) return invalidRequest(response, 'invalid interaction confirmation');
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
          const effectiveScopes: string[] = [];
          for (const [indicator, requestedScopes] of Object.entries(interaction.prompt.details.missingResourceScopes ?? {})) {
            const grantedScopes = requestedScopes.filter((scope) => scope === 'offline_access' || user.scopes.includes(scope));
            grant.addResourceScope(indicator, grantedScopes.join(' '));
            if (indicator === options.resource) effectiveScopes.push(...grantedScopes.filter((scope) => scope !== 'offline_access'));
          }
          const grantId = await grant.save();
          if (!user.sessionId) throw new Error('session bridge omitted a session binding');
          const client = await (provider as ProviderWithGrants).Client.find(interaction.params.client_id);
          const clientName = typeof client?.clientName === 'string' && client.clientName.trim() ? client.clientName.trim().slice(0, 160) : 'Connected assistant';
          if (!storeGrantBinding(db, grantId, { userId: user.id, sessionId: user.sessionId, clientId: interaction.params.client_id, clientName, resource: options.resource, scopes: [...new Set(effectiveScopes)], expiresAt: Date.now() + 1_209_600_000 })) throw new Error('grant session binding changed');
          result = { consent: { grantId } };
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? '3001');
  const issuer = process.env.OAUTH_ISSUER;
  const resource = process.env.OAUTH_RESOURCE;
  const databasePath = process.env.OAUTH_DATABASE_PATH;
  const cookieKeys = process.env.OAUTH_COOKIE_KEYS?.split(',').filter(Boolean) ?? [];
  const jwks = process.env.OAUTH_JWKS ? JSON.parse(process.env.OAUTH_JWKS) as { keys: Array<Record<string, unknown>> } : undefined;
  if (!issuer || !resource || !databasePath || cookieKeys.length < 2 || !jwks) throw new Error('OAUTH_ISSUER, OAUTH_RESOURCE, OAUTH_DATABASE_PATH, OAUTH_JWKS, and two OAUTH_COOKIE_KEYS are required');
  const cmsOrigin = process.env.OAUTH_CMS_ORIGIN;
  const bridgeSecret = process.env.OAUTH_BRIDGE_SECRET;
  // A missing or partial private bridge configuration must leave OAuth denied.
  const sessionBridge = cmsOrigin && bridgeSecret
    ? createHttpSessionBridge({ cmsOrigin, secret: bridgeSecret })
    : undefined;
  const service = createOAuthService({ issuer, resource, databasePath, cookieKeys, jwks, sessionBridge, trustProxy: process.env.OAUTH_TRUST_PROXY === 'true', onRegistrationFailure: (reason) => console.warn(`oauth_registration_rejected reason=${reason}`) });
  service.server.listen(port);
}
