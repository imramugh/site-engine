import { describe, expect, it } from 'vitest';
import {
  BlockSchema, PageSchema, SiteSnapshotSchema, ThemeInstallSchema,
  ThemeManifestSchema, compatibleContractVersion,
} from '../src/index.js';
import { neutralFixture } from '../src/fixtures.js';

const blockId = '33333333-3333-4333-8333-333333333333';
const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none' };
const cta = { id: blockId, type: 'cta', heading: 'Next steps', body: 'Read more.', cta: { label: 'Read', href: '/guide' }, appearance };
const fixture = () => structuredClone(neutralFixture);

describe('ENG-002 versioned contract', () => {
  it('accepts the neutral snapshot and compatible contract versions', () => {
    expect(SiteSnapshotSchema.safeParse(neutralFixture).success).toBe(true);
    expect(compatibleContractVersion('1.2.0')).toBe(true);
    expect(compatibleContractVersion('2.0.0')).toBe(false);
    expect(compatibleContractVersion('1.0.0-beta')).toBe(false);
    expect(ThemeInstallSchema.safeParse({ manifest: { name: 'neutral', version: '1.0.0', contract: '1.1.0', entry: './dist/index.js' }, installedAt: '2026-01-01T00:00:00.000Z' }).success).toBe(true);
  });

  it('rejects unknown appearance fields without confusing escaped prose with styling', () => {
    expect(BlockSchema.safeParse({ ...cta, colour: '#fff' }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...cta, appearance: { ...appearance, background: '#fff' } }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...cta, heading: 'Choosing a background: a guide' }).success).toBe(true);
    expect(BlockSchema.safeParse({ ...cta, heading: 'A title\u0000' }).success).toBe(false);
  });

  it.each(['//evil.example/path', '/\\evil.example', '/path\n', 'javascript:alert(1)'])('rejects unsafe link %s', (href) => {
    expect(BlockSchema.safeParse({ ...cta, cta: { label: 'Read', href } }).success).toBe(false);
  });

  it('requires testimonial permission to be recorded, while allowing unapproved drafts', () => {
    const testimonial = { id: blockId, type: 'testimonials', appearance, items: [{ quote: 'Synthetic quote', attribution: 'Example Person' }] };
    expect(BlockSchema.safeParse(testimonial).success).toBe(false);
    expect(BlockSchema.safeParse({ ...testimonial, items: [{ ...testimonial.items[0], permissionConfirmed: false }] }).success).toBe(true);
  });

  it('enforces background-video limits separately from content-video captions', () => {
    const backgroundVideo = { mediaId: blockId, posterMediaId: blockId, durationSeconds: 15, bytes: 3_000_000 };
    expect(BlockSchema.safeParse({ ...cta, appearance: { ...appearance, backgroundVideo } }).success).toBe(true);
    expect(BlockSchema.safeParse({ ...cta, appearance: { ...appearance, backgroundVideo: { ...backgroundVideo, bytes: 3_000_001 } } }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...cta, type: 'contact', cta: undefined, appearance: { ...appearance, backgroundVideo } }).success).toBe(false);
    const video = { id: blockId, type: 'video', appearance, mediaId: blockId, posterMediaId: blockId };
    expect(BlockSchema.safeParse(video).success).toBe(false);
    expect(BlockSchema.safeParse({ ...video, captionsMediaId: blockId }).success).toBe(true);
  });

  it('rejects manifest traversal instead of loading code outside the package', () => {
    expect(ThemeManifestSchema.safeParse({ name: 'neutral', version: '1.0.0', contract: '1.0.0', entry: './dist/../../private.js' }).success).toBe(false);
  });

  it('requires summaries, a visible landing hero, and compatible blocks', () => {
    const page = neutralFixture.pages[0];
    expect(PageSchema.safeParse({ ...page, summary: undefined }).success).toBe(false);
    expect(PageSchema.safeParse({ ...page, blocks: [] }).success).toBe(false);
    expect(PageSchema.safeParse({ ...page, template: 'job' }).success).toBe(false);
    expect(PageSchema.safeParse({ ...page, template: 'listing', blocks: [cta] }).success).toBe(true);
  });
});

describe('ENG-003 content tree validation', () => {
  it('rejects unknown section references and templates outside a section allowlist', () => {
    const snapshot = fixture();
    snapshot.pages[0].sectionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(false);
    const disallowed = fixture();
    disallowed.settings.sections[0].allowedTemplates = ['standard'];
    expect(SiteSnapshotSchema.safeParse(disallowed).success).toBe(false);
  });

  it('detects ancestry cycles and repeated page identifiers', () => {
    const snapshot = fixture();
    snapshot.pages[0].parentId = snapshot.pages[0].id;
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(false);
    const duplicates = fixture();
    duplicates.pages.push({ ...duplicates.pages[0] });
    expect(SiteSnapshotSchema.safeParse(duplicates).success).toBe(false);
  });

  it('rejects a fourth tree level and allows a three-level tree', () => {
    const snapshot = fixture();
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
    snapshot.settings.sections[0].allowedTemplates.push('standard');
    for (let i = 0; i < 2; i++) snapshot.pages.push({ ...snapshot.pages[0], id: ids[i], slug: `page-${i}`, template: 'standard', parentId: snapshot.pages.at(-1)!.id });
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(true);
    snapshot.pages.push({ ...snapshot.pages[0], id: ids[2], slug: 'page-three', template: 'standard', parentId: ids[1] });
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it('requires a service parent to be a pillar', () => {
    const snapshot = fixture();
    snapshot.pages.push({ ...snapshot.pages[0], id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'service', template: 'service', parentId: snapshot.pages[0].id });
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});
