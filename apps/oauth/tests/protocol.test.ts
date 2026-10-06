import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { createOAuthService } from '../src/server.js';

async function reserveEphemeralPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve a test port');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

test('enforces same-origin OAuth authorization-code boundaries', async () => {
const port = await reserveEphemeralPort();
const origin = `http://127.0.0.1:${port}`;
const issuer = `${origin}/oauth`;
const resource = `${origin}/mcp`;
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const databasePath = join(tmpdir(), `site-engine-oauth-${process.pid}.sqlite`);
const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
let currentUser = 'synthetic-user';
let userEnabled = true;
let currentScopes = ['mcp:content:read', 'mcp:leads:read'];
let bridgeAvailable = true;
const registrationFailures: string[] = [];
const previousIntrospectionSecret = process.env.OAUTH_INTROSPECTION_SECRET;
process.env.OAUTH_INTROSPECTION_SECRET = 'test-introspection-secret';

const service = createOAuthService({
  issuer,
  resource,
  databasePath,
  cookieKeys: ['test-cookie-key-one', 'test-cookie-key-two'],
  jwks: { keys: [{ ...signingKey, kid: 'test-key', use: 'sig', alg: 'RS256' }] },
  sessionBridge: {
    resolve: async () => ({ id: currentUser, sessionId: `${currentUser}-session`, enabled: userEnabled, scopes: currentScopes }),
    find: async (id, sessionId) => { if (!bridgeAvailable) throw new Error('synthetic bridge outage'); return ['synthetic-user', 'other-user'].includes(id) && (!sessionId || sessionId === `${id}-session`) ? { id, sessionId: `${id}-session`, enabled: userEnabled, scopes: currentScopes } : undefined; },
  },
  onRegistrationFailure: (reason) => registrationFailures.push(reason),
});

await new Promise<void>((resolve) => service.server.listen(port, '127.0.0.1', resolve));
try {
  const protectedMetadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(protectedMetadata.status, 200);
  assert.deepEqual(await protectedMetadata.json(), { resource, authorization_servers: [issuer], scopes_supported: ['mcp:content:read', 'mcp:content:write', 'mcp:redirects:read', 'mcp:redirects:write', 'mcp:leads:read', 'mcp:careers:read'] });

  const discovery = await fetch(`${issuer}/.well-known/openid-configuration`);
  assert.equal(discovery.status, 200);
  const metadata = await discovery.json() as { issuer: string; registration_endpoint: string; token_endpoint: string };
  assert.equal(metadata.issuer, issuer);
  assert.equal(metadata.registration_endpoint, `${issuer}/reg`);
  assert.equal((await fetch(`${origin}/.well-known/oauth-authorization-server/oauth`)).status, 200);

  const rejectedRegistration = await fetch(`${issuer}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/callback'], token_endpoint_auth_method: 'none', response_types: ['code'] }) });
  assert.equal(rejectedRegistration.status, 400);
  const wildcardRegistration = await fetch(`${issuer}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://*.example.test/callback'], token_endpoint_auth_method: 'none', response_types: ['code'] }) });
  assert.equal(wildcardRegistration.status, 400);
  assert.deepEqual(registrationFailures, ['invalid_redirect_uri', 'invalid_redirect_uri']);
  assert.equal((await fetch(`${issuer}/reg`)).status, 405);

  const webRegistration = await fetch(`${issuer}/reg`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      client_name: 'HTTPS public client', redirect_uris: ['https://client.example.test/oauth/callback'], token_endpoint_auth_method: 'none', response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], scope: 'mcp:content:read offline_access', application_type: 'web',
      client_uri: 'https://client.example.test', logo_uri: 'https://client.example.test/logo.svg', tos_uri: 'https://client.example.test/terms', policy_uri: 'https://client.example.test/privacy', contacts: ['support@example.test'], software_id: 'neutral-test-client', software_version: '1.0.0', extension_metadata: 'ignored',
    }),
  });
  assert.equal(webRegistration.status, 201);
  const webClient = await webRegistration.json() as { application_type: string; client_uri?: string; logo_uri?: string; policy_uri?: string; tos_uri?: string; contacts?: string[]; software_id?: string; software_version?: string; extension_metadata?: string };
  assert.equal(webClient.application_type, 'web');
  for (const key of ['client_uri', 'logo_uri', 'policy_uri', 'tos_uri', 'contacts', 'software_id', 'software_version', 'extension_metadata'] as const) assert.equal(webClient[key], undefined);

  const mismatchedApplicationType = await fetch(`${issuer}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none', response_types: ['code'], application_type: 'web' }) });
  assert.equal(mismatchedApplicationType.status, 400);
  assert.equal(registrationFailures.at(-1), 'application_type_mismatch');

  const nativeHttpsRegistration = await fetch(`${issuer}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Native HTTPS client', redirect_uris: ['https://native-client.example.test/callback'], token_endpoint_auth_method: 'none', response_types: ['code'], application_type: 'native', scope: 'mcp:content:read' }) });
  assert.equal(nativeHttpsRegistration.status, 201);
  assert.equal((await nativeHttpsRegistration.json() as { application_type: string }).application_type, 'native');

  const defaultScopeRegistration = await fetch(`${issuer}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/default-scope'], token_endpoint_auth_method: 'none', response_types: ['code'] }) });
  assert.equal(defaultScopeRegistration.status, 201);
  assert.equal((await defaultScopeRegistration.json() as { scope: string }).scope, 'mcp:content:read');
  const personalScopeRegistration = await fetch(`${issuer}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/personal-scope'], token_endpoint_auth_method: 'none', response_types: ['code'], scope: 'mcp:leads:read mcp:careers:read' }) });
  assert.equal(personalScopeRegistration.status, 201);
  assert.equal((await personalScopeRegistration.json() as { scope: string }).scope, 'mcp:leads:read mcp:careers:read');

  const nonStringScopeRegistration = await fetch(`${issuer}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/non-string-scope'], token_endpoint_auth_method: 'none', response_types: ['code'], scope: ['mcp:content:read'] }) });
  assert.equal(nonStringScopeRegistration.status, 400);
  assert.equal(registrationFailures.at(-1), 'unsupported_scope');

  const registered = await fetch(`${issuer}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Synthetic protocol client', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none', response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], scope: 'mcp:content:read mcp:leads:read offline_access' }) });
  assert.equal(registered.status, 201);
  const client = await registered.json() as { client_id: string; application_type: string };
  assert.equal(client.application_type, 'native');
  const registeredSecond = await fetch(`${issuer}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Independent synthetic client', redirect_uris: ['http://127.0.0.1/second-callback'], token_endpoint_auth_method: 'none', response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], scope: 'mcp:content:read offline_access' }) });
  assert.equal(registeredSecond.status, 201);
  const secondClient = await registeredSecond.json() as { client_id: string };

  const authorization = new URL(`${issuer}/auth`);
  authorization.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1/callback', scope: 'mcp:content:read mcp:leads:read offline_access', resource, state: 'state-value', code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  const authWithoutResource = new URL(authorization);
  authWithoutResource.searchParams.delete('resource');
  assert.equal((await fetch(authWithoutResource, { redirect: 'manual' })).status, 400);
  const authWrongResource = new URL(authorization);
  authWrongResource.searchParams.set('resource', `${origin}/other`);
  assert.equal((await fetch(authWrongResource, { redirect: 'manual' })).status, 400);
  const authWithoutPkce = new URL(authorization);
  authWithoutPkce.searchParams.delete('code_challenge');
  authWithoutPkce.searchParams.delete('code_challenge_method');
  const noPkce = await fetch(authWithoutPkce, { redirect: 'manual' });
  assert.equal(noPkce.status, 303);
  assert.match(noPkce.headers.get('location') ?? '', /error=invalid_request/);
  const authPlainPkce = new URL(authorization);
  authPlainPkce.searchParams.set('code_challenge_method', 'plain');
  const plainPkce = await fetch(authPlainPkce, { redirect: 'manual' });
  assert.equal(plainPkce.status, 303);
  assert.match(plainPkce.headers.get('location') ?? '', /error=invalid_request/);
  const authorizationResponse = await fetch(authorization, { redirect: 'manual' });
  assert.equal(authorizationResponse.status, 303);
  const interaction = authorizationResponse.headers.get('location');
  assert.ok(interaction?.startsWith('/oauth/interaction/'), interaction ?? 'missing interaction redirect');
  const cookies = new Map(authorizationResponse.headers.getSetCookie().map((value) => {
    const [pair] = value.split(';', 1);
    return [pair!.split('=', 1)[0]!, pair!];
  }));
  let next = new URL(interaction!, issuer);
  let callback: URL | undefined;
  let personalScopeWasShown = false;
  for (let redirects = 0; redirects < 8; redirects++) {
    const response = await fetch(next, { redirect: 'manual', headers: { cookie: [...cookies.values()].join('; ') } });
    if (response.status === 200) {
      const page = await response.text();
      if (page.includes('mcp:leads:read')) personalScopeWasShown = true;
      const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
      assert.ok(csrf, 'interaction page must include a CSRF confirmation');
      const confirmed = await fetch(next, {
        method: 'POST', redirect: 'manual', headers: {
          cookie: [...cookies.values()].join('; '), origin, 'content-type': 'application/x-www-form-urlencoded',
        }, body: new URLSearchParams({ csrf, decision: 'allow' }),
      });
      assert.equal(confirmed.status, 303);
      const location = confirmed.headers.get('location');
      assert.ok(location, 'missing OAuth redirect after confirmation');
      next = new URL(location, issuer);
      continue;
    }
    assert.equal(response.status, 303);
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';', 1);
      cookies.set(pair!.split('=', 1)[0]!, pair!);
    }
    const location = response.headers.get('location');
    assert.ok(location, 'missing OAuth redirect');
    const redirect = new URL(location!, issuer);
    if (redirect.origin === 'http://127.0.0.1' && redirect.pathname === '/callback') { callback = redirect; break; }
    next = redirect;
  }
  assert.equal(personalScopeWasShown, true);
  assert.ok(callback, 'authorization did not reach the registered redirect URI');
  assert.equal(callback.origin + callback.pathname, 'http://127.0.0.1/callback');
  assert.equal(callback.searchParams.get('state'), 'state-value');
  const code = callback.searchParams.get('code');
  assert.ok(code, callback.href);

  const missingTokenResource = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1/callback', client_id: client.client_id, code_verifier: verifier }) });
  assert.equal(missingTokenResource.status, 400);
  const wrongTokenResource = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1/callback', client_id: client.client_id, code_verifier: verifier, resource: `${origin}/other` }) });
  assert.equal(wrongTokenResource.status, 400);
  const duplicateTokenResource = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent('http://127.0.0.1/callback')}&client_id=${client.client_id}&code_verifier=${verifier}&resource=${encodeURIComponent(resource)}&resource=${encodeURIComponent(resource)}` });
  assert.equal(duplicateTokenResource.status, 400);
  const wrongRedirect = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1/other', client_id: client.client_id, code_verifier: verifier, resource }) });
  assert.equal(wrongRedirect.status, 400);
  const wrongClient = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1/callback', client_id: secondClient.client_id, code_verifier: verifier, resource }) });
  assert.equal(wrongClient.status, 400);
  assert.equal((await wrongClient.json() as { error?: string }).error, 'invalid_grant');

  const wrongVerifier = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1/callback', client_id: client.client_id, code_verifier: randomBytes(48).toString('base64url'), resource }) });
  assert.equal(wrongVerifier.status, 400);

  const token = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1/callback', client_id: client.client_id, code_verifier: verifier, resource }) });
  assert.equal(token.status, 200);
  const tokens = await token.json() as { access_token: string; refresh_token: string; token_type: string };
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.access_token && tokens.refresh_token, `token response fields: ${Object.keys(tokens).join(', ')}`);
  const introspection = async (tokenValue: string, secret = 'test-introspection-secret') => fetch(`${origin}/internal/introspect`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-oauth-introspection-secret': secret }, body: JSON.stringify({ token: tokenValue, clientId: client.client_id, resource }),
  });
  const active = await introspection(tokens.access_token);
  assert.equal(active.status, 200);
  const activeBody = await active.json() as { active: boolean; clientId: string; resource: string; scopes: string[]; userId: string; sessionId: string; expiresAt: number };
  assert.equal(activeBody.active, true);
  assert.equal(activeBody.clientId, client.client_id);
  assert.equal(activeBody.resource, resource);
  assert.deepEqual(activeBody.scopes, ['mcp:content:read', 'mcp:leads:read']);
  assert.equal(activeBody.userId, 'synthetic-user');
  assert.equal(activeBody.sessionId, 'synthetic-user-session');
  assert.equal(typeof activeBody.expiresAt, 'number');
  const managed = async () => fetch(`${origin}/internal/grants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-oauth-introspection-secret': 'test-introspection-secret' }, body: JSON.stringify({ operation: 'list', userId: 'synthetic-user' }) });
  assert.equal((await managed()).status, 200);
  bridgeAvailable = false;
  const unavailableManaged = await managed(); assert.equal(unavailableManaged.status, 503); assert.deepEqual(await unavailableManaged.json(), { error: 'session_bridge_unavailable' });
  bridgeAvailable = true;
  assert.equal((await introspection(tokens.access_token, 'wrong-secret')).status, 401);
  const malformedIntrospection = await fetch(`${origin}/internal/introspect`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-oauth-introspection-secret': 'test-introspection-secret' }, body: JSON.stringify({ token: tokens.access_token, resource, unexpected: true }) });
  assert.deepEqual(await malformedIntrospection.json(), { active: false });
  const sqlite = await import('node:sqlite');
  const db = new sqlite.DatabaseSync(databasePath);
  const issuedRows = db.prepare('SELECT model, payload FROM oidc_records').all() as Array<{ model: string; payload: string }>;
  assert.ok(issuedRows.some((row) => row.model === 'AccessToken'));
  assert.ok(issuedRows.some((row) => row.model === 'RefreshToken'));
  assert.ok(issuedRows.some((row) => row.model === 'AuthorizationCode'));
  const issuedPayloads = issuedRows.map((row) => row.payload).join('\n');
  for (const secret of [tokens.access_token, tokens.refresh_token, code]) assert.equal(issuedPayloads.includes(secret), false);
  assert.equal(issuedPayloads.includes('__adapter_lookup_id__'), true);

  const refreshed = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, resource }) });
  assert.equal(refreshed.status, 200);
  const rotated = await refreshed.json() as { access_token: string; refresh_token: string };
  assert.ok(rotated.refresh_token);
  const descendant = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rotated.refresh_token, client_id: client.client_id, resource }) });
  assert.equal(descendant.status, 200);
  const descendantTokens = await descendant.json() as { access_token: string; refresh_token: string };
  const liveDescendant = db.prepare('SELECT COUNT(*) AS count FROM oidc_records WHERE model IN (?, ?) AND id_hash IN (?, ?)').get('AccessToken', 'RefreshToken', createHash('sha256').update(descendantTokens.access_token).digest('base64url'), createHash('sha256').update(descendantTokens.refresh_token).digest('base64url')) as { count: number };
  assert.equal(liveDescendant.count, 2);
  currentScopes = [];
  const narrowedRefresh = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: descendantTokens.refresh_token, client_id: client.client_id, resource }) });
  assert.equal(narrowedRefresh.status, 400);
  currentScopes = ['mcp:content:read', 'mcp:leads:read'];
  userEnabled = false;
  const disabledRefresh = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: descendantTokens.refresh_token, client_id: client.client_id, resource }) });
  assert.equal(disabledRefresh.status, 400);
  userEnabled = true;
  const reusedRefresh = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, resource }) });
  assert.equal(reusedRefresh.status, 400);
  const revokedDescendant = db.prepare('SELECT COUNT(*) AS count FROM oidc_records WHERE model IN (?, ?) AND id_hash IN (?, ?)').get('AccessToken', 'RefreshToken', createHash('sha256').update(descendantTokens.access_token).digest('base64url'), createHash('sha256').update(descendantTokens.refresh_token).digest('base64url')) as { count: number };
  assert.equal(revokedDescendant.count, 0);

  userEnabled = false;
  const disabledAuthorization = await fetch(authorization, { redirect: 'manual', headers: { cookie: [...cookies.values()].join('; ') } });
  assert.equal(disabledAuthorization.status, 401);
  userEnabled = true;

  const reusedCode = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1/callback', client_id: client.client_id, code_verifier: verifier, resource }) });
  assert.equal(reusedCode.status, 400);
  const invalidVerifier = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: 'not-a-code', redirect_uri: 'http://127.0.0.1/callback', client_id: client.client_id, code_verifier: 'invalid', resource }) });
  assert.equal(invalidVerifier.status, 400);

  const records = db.prepare('SELECT payload FROM oidc_records').all() as Array<{ payload: string }>;
  const persisted = records.map((record) => record.payload).join('\n');
  assert.equal(persisted.includes(tokens.access_token), false);
  assert.equal(persisted.includes(tokens.refresh_token), false);
  assert.equal(persisted.includes(code), false);
  db.close();

  const gatedPort = await reserveEphemeralPort();
  const gatedOrigin = `http://127.0.0.1:${gatedPort}`;
  const gatedIssuer = `${gatedOrigin}/oauth`;
  const gated = createOAuthService({ issuer: gatedIssuer, resource: `${gatedOrigin}/mcp`, databasePath: `${databasePath}.gated`, cookieKeys: ['test-cookie-key-one', 'test-cookie-key-two'], jwks: { keys: [{ ...signingKey, kid: 'gated-key', use: 'sig', alg: 'RS256' }] } });
  await new Promise<void>((resolve) => gated.server.listen(gatedPort, '127.0.0.1', resolve));
  try {
    const gatedRegistration = await fetch(`${gatedIssuer}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none', response_types: ['code'], scope: 'mcp:content:read' }) });
    const gatedClient = await gatedRegistration.json() as { client_id: string };
    const gatedAuthorization = await fetch(`${gatedIssuer}/auth?${new URLSearchParams({ response_type: 'code', client_id: gatedClient.client_id, redirect_uri: 'http://127.0.0.1/callback', scope: 'mcp:content:read', resource: `${gatedOrigin}/mcp`, state: 'gated-state', code_challenge: challenge, code_challenge_method: 'S256' })}`, { redirect: 'manual' });
    assert.equal(gatedAuthorization.status, 303);
    const gatedInteraction = new URL(gatedAuthorization.headers.get('location')!, gatedIssuer);
    assert.equal((await fetch(gatedInteraction)).status, 401);
  } finally {
    await new Promise<void>((resolve) => gated.server.close(() => resolve()));
    gated.close();
    rmSync(`${databasePath}.gated`, { force: true });
    rmSync(`${databasePath}.gated-wal`, { force: true });
    rmSync(`${databasePath}.gated-shm`, { force: true });
  }
} finally {
  await new Promise<void>((resolve) => service.server.close(() => resolve()));
  service.close();
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  if (previousIntrospectionSecret === undefined) delete process.env.OAUTH_INTROSPECTION_SECRET;
  else process.env.OAUTH_INTROSPECTION_SECRET = previousIntrospectionSecret;
}
}, 30_000);
