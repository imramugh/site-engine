import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

export type OAuthBranding = { name?: string; logoFile?: string; directory?: string; stylesheet?: boolean; fonts: Set<string> };
export type PageOptions = { prefix: string; branding: OAuthBranding };

export const baseStylesheet = `:root{--oauth-background:#f5f5f4;--oauth-surface:#fff;--oauth-text:#1c1917;--oauth-muted:#57534e;--oauth-border:#d6d3d1;--oauth-accent:#1d4ed8;--oauth-accent-contrast:#fff;--oauth-font:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--oauth-brand-background:transparent;--oauth-brand-text:var(--oauth-text)}*{box-sizing:border-box}html{background:var(--oauth-background)}body{margin:0;min-width:320px;background:var(--oauth-background);color:var(--oauth-text);font-family:var(--oauth-font);line-height:1.5}.oauth-page{min-height:100vh;padding:24px 16px;display:grid;place-items:center}.oauth-card{width:min(100%,620px);background:var(--oauth-surface);border:1px solid var(--oauth-border);border-radius:8px;overflow:hidden;padding:0;box-shadow:0 14px 36px rgb(28 25 23 / .10)}.oauth-brand{display:flex;align-items:center;gap:12px;min-height:108px;padding:28px 32px;color:var(--oauth-brand-text);background:var(--oauth-brand-background);font-weight:700}.oauth-content{padding:32px}.oauth-brand img{width:160px;height:50px;object-fit:contain;object-position:left center}.oauth-heading{font-size:clamp(1.75rem,5vw,2.25rem);line-height:1.15;margin:0 0 12px}.oauth-description{overflow-wrap:anywhere;margin:0 0 18px;color:var(--oauth-muted)}.oauth-details{font-size:.925rem;margin:0 0 20px;padding:12px;background:color-mix(in srgb,var(--oauth-background) 70%,var(--oauth-surface));border-radius:8px;overflow-wrap:anywhere}.oauth-details summary{min-height:24px;cursor:pointer}.oauth-permissions{margin:0 0 24px;padding:0;list-style:none;border-top:1px solid var(--oauth-border)}.oauth-permissions li{padding:13px 0;border-bottom:1px solid var(--oauth-border)}.oauth-permissions strong,.oauth-permissions span{display:block}.oauth-permissions span{color:var(--oauth-muted);font-size:.925rem}.oauth-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}.oauth-button,.oauth-secondary{min-height:44px;padding:10px 18px;border-radius:8px;font:inherit;font-weight:650;cursor:pointer;text-align:center;text-decoration:none}.oauth-button{border:1px solid var(--oauth-accent);background:var(--oauth-accent);color:var(--oauth-accent-contrast)}.oauth-secondary{border:1px solid var(--oauth-border);background:var(--oauth-surface);color:var(--oauth-text)}.oauth-button:focus-visible,.oauth-secondary:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid var(--oauth-accent);outline-offset:3px}.oauth-button:hover{filter:brightness(.93)}@media(max-width:380px){.oauth-page{padding:12px}.oauth-content{padding:24px 20px}.oauth-actions>*{width:100%}}`;

export const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);

function validFilename(value: unknown, extensions: readonly string[]): value is string {
  return typeof value === 'string' && value === basename(value) && value.length > 0 && value.length <= 128 && extensions.includes(extname(value).toLowerCase());
}

function regularFile(directory: string, filename: string): string | undefined {
  const candidate = resolve(directory, filename);
  if (!candidate.startsWith(`${directory}/`) || !lstatSync(candidate, { throwIfNoEntry: false })?.isFile() || lstatSync(candidate).isSymbolicLink()) return undefined;
  return candidate;
}

/** Reads only a small deployment-owned manifest; invalid optional branding falls back to neutral UI. */
export function loadOAuthBranding(directory?: string): OAuthBranding {
  const neutral: OAuthBranding = { fonts: new Set() };
  if (!directory) return neutral;
  let resolved: string;
  try { resolved = realpathSync(directory); } catch { return neutral; }
  if (!lstatSync(resolved).isDirectory()) return neutral;
  const manifest = regularFile(resolved, 'branding.json');
  if (!manifest) return neutral;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return neutral;
    const value = parsed as Record<string, unknown>;
    const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 120) : undefined;
    const logoFile = validFilename(value.logoFile, ['.svg', '.png', '.webp']) && regularFile(resolved, value.logoFile) ? value.logoFile : undefined;
    const stylesheet = Boolean(regularFile(resolved, 'branding.css'));
    const fonts = new Set<string>();
    for (const filename of readdirSync(resolved)) if (validFilename(filename, ['.woff2']) && regularFile(resolved, filename)) fonts.add(filename);
    return { name, logoFile, directory: resolved, stylesheet, fonts };
  } catch { return neutral; }
}

export function assetForBranding(branding: OAuthBranding, filename: string): { path: string; mime: string } | undefined {
  if (!branding.directory || filename !== basename(filename)) return undefined;
  const allowed = filename === 'branding.css' && branding.stylesheet
    ? 'text/css; charset=utf-8'
    : filename === branding.logoFile ? ({ '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' }[extname(filename).toLowerCase()])
      : branding.fonts.has(filename) ? 'font/woff2' : undefined;
  const path = allowed && regularFile(branding.directory, filename);
  return path && allowed ? { path, mime: allowed } : undefined;
}

function shell(options: PageOptions, title: string, content: string): string {
  const { prefix, branding } = options;
  const style = '<link rel="stylesheet" href="' + escapeHtml(prefix + '/assets/base.css') + '">' + (branding.stylesheet ? '<link rel="stylesheet" href="' + escapeHtml(prefix + '/assets/branding.css') + '">' : '');
  const brand = branding.logoFile
    ? `<div class="oauth-brand"><img src="${escapeHtml(`${prefix}/assets/${branding.logoFile}`)}" alt="${escapeHtml(branding.name ?? 'Service')}" width="160" height="50"></div>`
    : branding.name ? `<div class="oauth-brand">${escapeHtml(branding.name)}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>${style}</head><body><main class="oauth-page"><section class="oauth-card" aria-labelledby="oauth-title">${brand}<div class="oauth-content">${content}</div></section></main></body></html>`;
}

export function renderRecovery(options: PageOptions, retry: string): string {
  return shell(options, 'Sign in required', `<h1 class="oauth-heading" id="oauth-title">Sign in required</h1><p class="oauth-description">Sign in, then retry this authorization request.</p><div class="oauth-actions"><a class="oauth-button" href="/admin/login" target="_blank" rel="noopener">Open sign in</a><a class="oauth-secondary" href="${escapeHtml(retry)}">Retry authorization</a></div>`);
}

export const scopeDescription = (scope: string): string => ({
  'sign in': 'Confirm your signed-in identity.',
  'mcp:content:read': 'View site content.', 'mcp:content:write': 'Create and edit content drafts for review.',
  'mcp:redirects:read': 'View redirects.', 'mcp:redirects:write': 'Propose redirect changes for review.',
  'mcp:leads:read': 'View leads.', 'mcp:leads:write': 'Create and update leads.', 'mcp:leads:reply': 'Prepare and send human-confirmed replies to leads.',
  'mcp:careers:read': 'View job applications.', 'mcp:careers:write': 'Update job application records.',
  'mcp:careers:reply': 'Prepare and send human-confirmed replies to applicants.', offline_access: 'Keep this connection usable until your session expires or you revoke it.',
}[scope] ?? 'Requested permission from the connecting application.');

export function renderConsent(options: PageOptions, values: { action: string; csrf: string; clientId: string; clientName?: string; scopes: string[] }): string {
  const name = values.clientName?.trim().slice(0, 160) || 'Connected assistant';
  const scopes = values.scopes.length ? values.scopes : ['sign in'];
  const summary = values.scopes.length ? '' : `<p class="oauth-description">Requested access: sign in</p>`;
  const permissions = scopes.map((scope) => `<li><strong>${escapeHtml(scopeDescription(scope))}</strong></li>`).join('');
  return shell(options, 'Authorize access', `<h1 class="oauth-heading" id="oauth-title">Authorize access</h1><p class="oauth-description"><strong>${escapeHtml(name)}</strong> <span>(provided by the connecting app)</span> requests access to your account.</p><details class="oauth-details"><summary>Connection details</summary><p>Application ID: <code>${escapeHtml(values.clientId)}</code></p><p>Requested scopes: <code>${scopes.map(escapeHtml).join(", ")}</code></p></details>${summary}<ul class="oauth-permissions" aria-label="Requested permissions">${permissions}</ul><form method="post" action="${escapeHtml(values.action)}"><input type="hidden" name="csrf" value="${escapeHtml(values.csrf)}"><div class="oauth-actions"><button class="oauth-button" type="submit" name="decision" value="allow">Allow</button><button class="oauth-secondary" type="submit" name="decision" value="deny">Deny</button></div></form>`);
}

export function renderLogout(options: PageOptions, form: string, host: string): string {
  return shell(options, 'Sign out', `<h1 class="oauth-heading" id="oauth-title">Sign out</h1><p class="oauth-description">Do you want to sign out from ${escapeHtml(host)}?</p>${form}<div class="oauth-actions"><button autofocus class="oauth-button" type="submit" form="op.logoutForm" value="yes" name="logout">Yes, sign me out</button><button class="oauth-secondary" type="submit" form="op.logoutForm">No, stay signed in</button></div>`);
}

export function renderLogoutSuccess(options: PageOptions, clientName?: string): string {
  const display = clientName?.trim() ? ` from ${escapeHtml(clientName.slice(0, 160))}` : '';
  return shell(options, 'Signed out', `<h1 class="oauth-heading" id="oauth-title">Signed out</h1><p class="oauth-description">You have ended this authorization session${display}. Your staff workspace sign-in is unchanged.</p>`);
}

export function renderBrowserError(options: PageOptions): string {
  return shell(options, 'Unable to continue', `<h1 class="oauth-heading" id="oauth-title">Unable to continue</h1><p class="oauth-description">This request could not be completed. Return to the connecting application and try again. If the problem continues, contact the application’s administrator.</p>`);
}
