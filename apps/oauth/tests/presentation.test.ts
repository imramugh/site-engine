import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { assetForBranding, loadOAuthBranding, renderBrowserError, renderConsent, scopeDescription } from '../src/presentation.js';

const neutral = { fonts: new Set<string>() };

test('escapes untrusted consent values and keeps unknown scopes visible', () => {
  const page = renderConsent({ prefix: '/oauth', branding: neutral }, { action: '/oauth/interaction/x', csrf: '<csrf>', clientId: '<client>', clientName: '<app>', scopes: ['mcp:content:read', 'mcp:content:publish', 'unknown:<scope>', 'offline_access'] });
  assert.match(page, /&lt;app&gt;/);
  assert.doesNotMatch(page, /<app>/);
  assert.match(page, /View site content\./);
  assert.match(page, /Approve and publish reviewed content on your behalf\./);
  assert.match(page, /Requested permission from the connecting application\./);
  assert.match(page, /Keep this connection usable until your session expires or you revoke it\./);
  assert.match(page, /Requested scopes: <code>mcp:content:read, mcp:content:publish, unknown:&lt;scope&gt;, offline_access<\/code>/);
  assert.match(renderBrowserError({ prefix: '/oauth', branding: neutral }), /Unable to continue/);
  assert.equal(scopeDescription('unrecognized'), 'Requested permission from the connecting application.');
});

test('loads only local validated branding assets', () => {
  for (const scope of ["mcp:content:write", "mcp:content:publish", "mcp:redirects:read", "mcp:redirects:write", "mcp:leads:read", "mcp:leads:write", "mcp:leads:reply", "mcp:careers:read", "mcp:careers:write", "mcp:careers:reply"]) assert.notEqual(scopeDescription(scope), "Requested permission from the connecting application.");
  const directory = mkdtempSync(join(tmpdir(), 'oauth-brand-'));
  writeFileSync(join(directory, 'branding.json'), JSON.stringify({ name: 'Test brand', logoFile: 'logo.svg' }));
  writeFileSync(join(directory, 'logo.svg'), '<svg/>');
  writeFileSync(join(directory, 'branding.css'), ':root{}');
  writeFileSync(join(directory, 'staff.woff2'), 'font');
  const branding = loadOAuthBranding(directory);
  assert.equal(branding.name, 'Test brand');
  assert.equal(assetForBranding(branding, 'logo.svg')?.mime, 'image/svg+xml');
  assert.equal(assetForBranding(branding, 'staff.woff2')?.mime, 'font/woff2');
  assert.equal(assetForBranding(branding, '../branding.json'), undefined);
  assert.equal(assetForBranding(branding, 'branding.json'), undefined);
});

test('rejects symlinked and traversal branding files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oauth-brand-invalid-'));
  const outside = mkdtempSync(join(tmpdir(), 'oauth-brand-outside-'));
  writeFileSync(join(outside, 'logo.svg'), '<svg/>');
  symlinkSync(join(outside, 'logo.svg'), join(directory, 'logo.svg'));
  writeFileSync(join(directory, 'branding.json'), JSON.stringify({ name: 'Unsafe', logoFile: '../logo.svg' }));
  const traversal = loadOAuthBranding(directory);
  assert.equal(traversal.logoFile, undefined);
  writeFileSync(join(directory, 'branding.json'), JSON.stringify({ name: 'Unsafe', logoFile: 'logo.svg' }));
  const linked = loadOAuthBranding(directory);
  assert.equal(linked.logoFile, undefined);
});


test('every supported permission has a specific human-readable description', () => {
  const scopes = ['mcp:content:read', 'mcp:content:write', 'mcp:content:publish', 'mcp:redirects:read', 'mcp:redirects:write', 'mcp:leads:read', 'mcp:leads:write', 'mcp:leads:reply', 'mcp:careers:read', 'mcp:careers:write', 'mcp:careers:reply', 'offline_access', 'sign in'];
  for (const scope of scopes) {
    assert.notEqual(scopeDescription(scope), scopeDescription('unknown'));
    assert.doesNotMatch(scopeDescription(scope), /mcp:/);
  }
  assert.match(scopeDescription('mcp:content:write'), /drafts for review/);
  assert.match(scopeDescription('mcp:content:publish'), /Approve and publish reviewed content on your behalf/);
  assert.match(scopeDescription('mcp:leads:reply'), /human-confirmed/);
});
