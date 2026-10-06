import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteSnapshotSchema, type Block, type Page, type SiteSnapshot } from '@site-engine/contract';

export type IsolatedSqlite = Readonly<{ directory: string; path: string; uri: string }>;

/** Runs against a fresh file SQLite location and removes its database and journal files afterwards. */
export async function withIsolatedSqlite<T>(run: (database: IsolatedSqlite) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'site-engine-sqlite-'));
  const path = join(directory, 'cms.sqlite');
  try { return await run({ directory, path, uri: `file:${path}` }); } finally { await rm(directory, { recursive: true, force: true }); }
}

/** @deprecated Prefer withIsolatedSqlite when a database URI or fixture root is also needed. */
export async function withIsolatedSqlitePath<T>(run: (path: string) => Promise<T>): Promise<T> {
  return withIsolatedSqlite(({ path }) => run(path));
}
export const artifactName = (story: string, browser: string, test: string) => `${story}-${browser}-${test.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

/** Removes credentials from logs before a failure artifact leaves an isolated test workspace. */
export function scrubFailureLog(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|password|cookie)\s*[=:]\s*["']?)[^\s,"';}]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s@/]+@/gi, '$1[REDACTED]@');
}

export { assertBoundaries, inspectBoundaries } from './assert-boundaries.js';

export type CheckSeverity = 'blocker' | 'warning';

export type QualityIssue = {
  code: string;
  severity: CheckSeverity;
  path: string;
  message: string;
  remediation: string;
  pageId?: string;
  blockId?: string;
};

export type StalePage = {
  id: string;
  title: string;
  path: string;
  reviewAgeDays: number;
};

export type StructuredData = Readonly<Record<string, unknown>>;

export type QualityCheckOptions = {
  /**
   * The audit time. Supplying it makes freshness output repeatable across save,
   * review, and build. If omitted, the latest content timestamp is used.
   */
  asOf?: string | Date;
  reviewFreshnessDays?: number;
  titleLength?: { min: number; max: number };
  descriptionLength?: { min: number; max: number };
  style?: {
    bannedPhrases?: readonly string[];
    preferredTerms?: readonly { avoid: string; prefer: string }[];
    canadianSpelling?: 'off' | 'warn';
    maximumSentenceWords?: number;
    minimumReadingEase?: number;
  };
  /** Generated JSON-LD keyed by published page ID. Omit when generation is not installed. */
  structuredData?: Readonly<Record<string, StructuredData | unknown>>;
  allowlistedOrphanPageIds?: readonly string[];
};

export type QualityReport = {
  version: 1;
  asOf: string;
  publishable: boolean;
  issues: readonly QualityIssue[];
  blockers: readonly QualityIssue[];
  warnings: readonly QualityIssue[];
  stalePages: readonly StalePage[];
  ai: { status: 'unavailable'; code: 'AI_PROVIDER_UNAVAILABLE'; message: string };
};

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TITLE_LENGTH = { min: 15, max: 60 };
const DEFAULT_DESCRIPTION_LENGTH = { min: 50, max: 160 };
const DEFAULT_MAX_SENTENCE_WORDS = 30;
const DEFAULT_MIN_READING_EASE = 30;
const AMERICAN_TO_CANADIAN: Readonly<Record<string, string>> = {
  color: 'colour', colors: 'colours', behavior: 'behaviour', behaviors: 'behaviours',
  center: 'centre', centers: 'centres', favorite: 'favourite', favorites: 'favourites',
  
};

function issue(issues: QualityIssue[], value: QualityIssue): void { issues.push(value); }
function text(value: string): string { return value.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_>#]/g, ' ').replace(/\s+/g, ' ').trim(); }
function words(value: string): string[] { return text(value).match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) ?? []; }
function sentences(value: string): string[] { return text(value).split(/[.!?]+/).map((item) => item.trim()).filter(Boolean); }
function syllables(word: string): number { const normalized = word.toLowerCase().replace(/[^a-z]/g, '').replace(/e$/, ''); return Math.max(1, (normalized.match(/[aeiouy]+/g) ?? []).length); }
function readingEase(value: string): number | undefined {
  const wordList = words(value); const sentenceList = sentences(value);
  if (!wordList.length || !sentenceList.length) return undefined;
  return 206.835 - 1.015 * (wordList.length / sentenceList.length) - 84.6 * (wordList.reduce((total, word) => total + syllables(word), 0) / wordList.length);
}
function markdownLinks(value: string): string[] { return [...value.matchAll(/\[[^\]]+\]\((\/[^)\s#?]*(?:#[^)\s?]+)?)\)/g)].map((match) => match[1]!); }
function markdownHeadings(value: string): number[] { return [...value.matchAll(/^(#{1,6})\s+\S/gm)].map((match) => match[1]!.length); }
function pageText(page: Page): string[] {
  const values = [page.title, page.summary, page.seoDescription ?? ''];
  for (const block of page.blocks.filter((block) => !block.hidden)) {
    if ('heading' in block && typeof block.heading === 'string') values.push(block.heading);
    if ('body' in block && typeof block.body === 'string') values.push(block.body);
    if ('items' in block && Array.isArray(block.items)) for (const item of block.items) {
      if (typeof item === 'string') values.push(item);
      else if (item && typeof item === 'object') for (const field of ['title', 'body', 'question', 'answer', 'quote', 'attribution']) { const value = (item as Record<string, unknown>)[field]; if (typeof value === 'string') values.push(value); }
    }
    if (block.type === 'contact' && block.contactDetails) {
      const details = block.contactDetails;
      if (details.incidentCallout) values.push(details.incidentCallout.label, details.incidentCallout.body, details.incidentCallout.phoneLabel ?? '');
      for (const channel of details.channels ?? []) values.push(channel.label, channel.value);
      values.push(details.nextStepsHeading ?? '');
      for (const step of details.nextSteps ?? []) values.push(step.title, step.body);
    }
  }
  return values;
}
function pagePath(page: Page, pages: ReadonlyMap<string, Page>, sectionSlugs: ReadonlyMap<string, string>, homepageId: string | undefined, landingIds: ReadonlyMap<string, string | undefined>): string {
  if (page.id === homepageId) return '/';
  if (page.id === landingIds.get(page.sectionId)) return `/${sectionSlugs.get(page.sectionId)}`;
  const ancestors: Page[] = []; let current = page;
  while (current.parentId) { const parent = pages.get(current.parentId); if (!parent) break; ancestors.unshift(parent); current = parent; }
  return `/${[sectionSlugs.get(page.sectionId) ?? '', ...ancestors.filter(ancestor => ancestor.id !== landingIds.get(page.sectionId)).map((ancestor) => ancestor.slug), page.slug].filter(Boolean).join('/')}`;
}
function checkStructuredData(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Generated structured data must be a JSON object.';
  try { JSON.stringify(value); } catch { return 'Generated structured data must be JSON serializable.'; }
  const document = value as Record<string, unknown>;
  if (document['@context'] !== 'https://schema.org' || !Array.isArray(document['@graph'])) return 'Generated structured data must contain schema.org @context and an @graph array.';
  return undefined;
}
function resolvedAsOf(snapshot: SiteSnapshot, requested: string | Date | undefined): Date {
  const candidate = requested === undefined ? snapshot.pages.map((page) => page.updatedAt ?? page.publishedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? '1970-01-01T00:00:00.000Z' : requested;
  const date = new Date(candidate); if (Number.isNaN(date.getTime())) throw new Error('Quality check asOf must be a valid ISO timestamp.');
  return date;
}

/**
 * Performs deterministic, content-only readiness checks. It deliberately does
 * not call an AI provider: callers always receive an explicit unavailable AI
 * status until a separately configured provider is approved.
 */
export function checkSiteSnapshot(input: unknown, options: QualityCheckOptions = {}): QualityReport {
  const parsed = SiteSnapshotSchema.safeParse(input);
  const issues: QualityIssue[] = [];
  if (!parsed.success) {
    for (const invalid of parsed.error.issues) issue(issues, { code: 'SCHEMA_INVALID', severity: 'blocker', path: invalid.path.length ? invalid.path.join('.') : '$', message: invalid.message, remediation: 'Correct this field so the snapshot satisfies the public content contract.' });
    return report('1970-01-01T00:00:00.000Z', issues, []);
  }
  const snapshot = parsed.data; const asOf = resolvedAsOf(snapshot, options.asOf);
  const pages = new Map(snapshot.pages.map((page) => [page.id, page]));
  const sectionSlugs = new Map(snapshot.settings.sections.map((section) => [section.id, section.slug]));
  const landingIds = new Map(snapshot.settings.sections.map(section => [section.id, section.landingPageId]));
  const published = snapshot.pages.filter((page) => { if (page.status !== 'published') return false; let parent = page.parentId ? pages.get(page.parentId) : undefined; while (parent) { if (parent.status !== 'published') return false; parent = parent.parentId ? pages.get(parent.parentId) : undefined; } return true; });
  const paths = new Map(published.map((page) => [pagePath(page, pages, sectionSlugs, snapshot.settings.homepageId, landingIds), page]));
  const titleLength = options.titleLength ?? DEFAULT_TITLE_LENGTH; const descriptionLength = options.descriptionLength ?? DEFAULT_DESCRIPTION_LENGTH;
  const maxSentenceWords = options.style?.maximumSentenceWords ?? DEFAULT_MAX_SENTENCE_WORDS; const minReadingEase = options.style?.minimumReadingEase ?? DEFAULT_MIN_READING_EASE;
  const inbound = new Set<string>(); const stalePages: StalePage[] = [];
  for (const page of published) {
    const base = `pages.${snapshot.pages.indexOf(page)}`; const content = pageText(page); const prose = content.join('. ');
    if (page.summary.length < descriptionLength.min || page.summary.length > descriptionLength.max) issue(issues, { code: 'SUMMARY_LENGTH', severity: 'warning', path: `${base}.summary`, pageId: page.id, message: `Summary is ${page.summary.length} characters; target ${descriptionLength.min}-${descriptionLength.max}.`, remediation: 'Revise the summary to the configured description range.' });
    if (page.title.length < titleLength.min || page.title.length > titleLength.max) issue(issues, { code: 'TITLE_LENGTH', severity: 'warning', path: `${base}.title`, pageId: page.id, message: `Title is ${page.title.length} characters; target ${titleLength.min}-${titleLength.max}.`, remediation: 'Revise the title to the configured title range.' });
    if (!page.seoDescription) issue(issues, { code: 'SEO_DESCRIPTION_MISSING', severity: 'warning', path: `${base}.seoDescription`, pageId: page.id, message: 'SEO description is missing.', remediation: 'Add a concise page description for search results.' });
    else if (page.seoDescription.length < descriptionLength.min || page.seoDescription.length > descriptionLength.max) issue(issues, { code: 'SEO_DESCRIPTION_LENGTH', severity: 'warning', path: `${base}.seoDescription`, pageId: page.id, message: `SEO description is ${page.seoDescription.length} characters; target ${descriptionLength.min}-${descriptionLength.max}.`, remediation: 'Revise the SEO description to the configured description range.' });
    const authoredHeadings = content.flatMap(markdownHeadings); const h1Count = 1 + authoredHeadings.filter((level) => level === 1).length;
    if (h1Count !== 1) issue(issues, { code: 'HEADING_H1_COUNT', severity: 'blocker', path: `${base}.blocks`, pageId: page.id, message: `Page has ${h1Count} H1 headings; the page title supplies one H1.`, remediation: 'Remove authored H1 headings and use H2 or lower in body content.' });
    let previous = 1; for (const level of authoredHeadings) { if (level > previous + 1) { issue(issues, { code: 'HEADING_ORDER', severity: 'blocker', path: `${base}.blocks`, pageId: page.id, message: `Heading level H${level} follows H${previous}.`, remediation: 'Use heading levels in order without skipping a level.' }); break; } previous = level; }
    for (const block of page.blocks.filter((block) => !block.hidden)) if (block.type === 'faq') for (const [itemIndex, item] of block.items.entries()) {
      const answer = text(item.answer); if (answer.length < 20 || /^(?:yes|no|it|this|that|they|there)\b/i.test(answer)) issue(issues, { code: 'FAQ_SELF_CONTAINED', severity: 'warning', path: `${base}.blocks.${page.blocks.indexOf(block)}.items.${itemIndex}.answer`, pageId: page.id, blockId: block.id, message: 'FAQ answer may not stand on its own outside the page context.', remediation: 'State the subject and answer directly in a complete sentence.' });
    }
    const route = pagePath(page, pages, sectionSlugs, snapshot.settings.homepageId, landingIds);
    for (const link of collectLinks(page)) { if (!link.href.startsWith('/') || link.href.startsWith('//')) continue; const [pathPart, fragment] = link.href.split('#', 2); const target = (pathPart ?? '').replace(/\/+$/, '') || '/'; const linked = paths.get(target); if (!linked && !snapshot.redirects.some((redirect) => redirect.from === target)) issue(issues, { code: 'INTERNAL_LINK_BROKEN', severity: 'blocker', path: `${base}.${link.field}`, pageId: page.id, blockId: link.blockId, message: `Internal link ${link.href} does not resolve to a published page or redirect.`, remediation: 'Update the link to a published path or add a redirect.' }); else if (fragment && (!linked || !linked.blocks.some((block) => !block.hidden && block.anchorId === fragment))) issue(issues, { code: 'INTERNAL_LINK_ANCHOR_BROKEN', severity: 'blocker', path: `${base}.${link.field}`, pageId: page.id, blockId: link.blockId, message: `Internal link anchor ${link.href} does not resolve to a published block anchor.`, remediation: 'Update the fragment to an anchor on the published target page.' }); else if (linked) inbound.add(linked.id); }
    const freshness = page.lastReviewed ?? page.updatedAt ?? page.publishedAt; if (freshness) { const age = Math.max(0, Math.floor((asOf.getTime() - new Date(freshness).getTime()) / DAY)); if (age > (options.reviewFreshnessDays ?? 180)) { const stale = { id: page.id, title: page.title, path: route, reviewAgeDays: age }; stalePages.push(stale); issue(issues, { code: 'REVIEW_STALE', severity: 'warning', path: `${base}.${page.lastReviewed ? 'lastReviewed' : 'updatedAt'}`, pageId: page.id, message: `Page review age is ${age} days.`, remediation: 'Review the page and update its content timestamp.' }); } }
    for (const phrase of options.style?.bannedPhrases ?? []) if (phrase && new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i').test(prose)) issue(issues, { code: 'STYLE_BANNED_PHRASE', severity: 'warning', path: base, pageId: page.id, message: `Content uses banned phrase “${phrase}”.`, remediation: 'Replace the banned phrase with approved language.' });
    for (const term of options.style?.preferredTerms ?? []) if (term.avoid && new RegExp(`\\b${escapeRegExp(term.avoid)}\\b`, 'i').test(prose)) issue(issues, { code: 'STYLE_PREFERRED_TERM', severity: 'warning', path: base, pageId: page.id, message: `Use “${term.prefer}” instead of “${term.avoid}”.`, remediation: 'Replace the term with the configured preferred term.' });
    if (options.style?.canadianSpelling === 'warn') for (const [american, canadian] of Object.entries(AMERICAN_TO_CANADIAN)) if (new RegExp(`\\b${american}\\b`, 'i').test(prose)) issue(issues, { code: 'STYLE_CANADIAN_SPELLING', severity: 'warning', path: base, pageId: page.id, message: `Use Canadian spelling “${canadian}” instead of “${american}”.`, remediation: 'Replace the American spelling with the configured Canadian spelling.' });
    if (sentences(prose).some((sentence) => words(sentence).length > maxSentenceWords)) issue(issues, { code: 'STYLE_SENTENCE_LENGTH', severity: 'warning', path: base, pageId: page.id, message: `Content contains a sentence longer than ${maxSentenceWords} words.`, remediation: 'Split the long sentence into shorter sentences.' });
    const ease = readingEase(prose); if (ease !== undefined && ease < minReadingEase) issue(issues, { code: 'STYLE_READING_LEVEL', severity: 'warning', path: base, pageId: page.id, message: `Reading ease is ${ease.toFixed(1)}, below ${minReadingEase}.`, remediation: 'Use shorter words and sentences to improve readability.' });
    if (page.id in (options.structuredData ?? {})) { const error = checkStructuredData(options.structuredData?.[page.id]); if (error) issue(issues, { code: 'STRUCTURED_DATA_INVALID', severity: 'blocker', path: `structuredData.${page.id}`, pageId: page.id, message: error, remediation: 'Fix structured-data generation before publishing.' }); }
  }
  for (const page of published) if (page.id !== snapshot.settings.homepageId && !page.parentId && !inbound.has(page.id) && !(options.allowlistedOrphanPageIds ?? []).includes(page.id)) issue(issues, { code: 'ORPHAN_PAGE', severity: 'warning', path: `pages.${snapshot.pages.indexOf(page)}`, pageId: page.id, message: `Published page ${pagePath(page, pages, sectionSlugs, snapshot.settings.homepageId, landingIds)} has no inbound internal link.`, remediation: 'Link to this page from relevant published content or allowlist it intentionally.' });
  return report(asOf.toISOString(), issues, stalePages);
}

function collectLinks(page: Page): { href: string; field: string; blockId?: string }[] {
  const links: { href: string; field: string; blockId?: string }[] = [];
  for (const [index, block] of page.blocks.entries()) { if (block.hidden) continue; const field = `blocks.${index}`; if ('cta' in block && block.cta) links.push({ href: block.cta.href, field: `${field}.cta.href`, blockId: block.id }); if (block.type === 'hero') { if (block.secondaryCta) links.push({ href: block.secondaryCta.href, field: `${field}.secondaryCta.href`, blockId: block.id }); if (block.supportPanel?.cta) links.push({ href: block.supportPanel.cta.href, field: `${field}.supportPanel.cta.href`, blockId: block.id }); } if (block.type === 'pillarGrid') for (const [itemIndex, item] of block.items.entries()) { links.push({ href: item.href, field: `${field}.items.${itemIndex}.href`, blockId: block.id }); for (const [linkIndex, link] of (item.links ?? []).entries()) links.push({ href: link.href, field: `${field}.items.${itemIndex}.links.${linkIndex}.href`, blockId: block.id }); } if (block.type === 'relatedServices') for (const [linkIndex, link] of (block.links ?? []).entries()) links.push({ href: link.href, field: `${field}.links.${linkIndex}.href`, blockId: block.id }); for (const value of blockText(block)) for (const href of markdownLinks(value)) links.push({ href, field, blockId: block.id }); }
  return links;
}
function blockText(block: Block): string[] { const values: string[] = []; if ('body' in block && typeof block.body === 'string') values.push(block.body); if (block.type === 'hero' && block.supportPanel) values.push(block.supportPanel.heading, block.supportPanel.body); if (block.type === 'faq') values.push(...block.items.flatMap((item) => [item.question, item.answer])); return values; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function report(asOf: string, issues: QualityIssue[], stalePages: StalePage[]): QualityReport { const ordered = issues.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code)); const blockers = ordered.filter((value) => value.severity === 'blocker'); return { version: 1, asOf, publishable: blockers.length === 0, issues: ordered, blockers, warnings: ordered.filter((value) => value.severity === 'warning'), stalePages: stalePages.sort((left, right) => left.path.localeCompare(right.path)), ai: { status: 'unavailable', code: 'AI_PROVIDER_UNAVAILABLE', message: 'AI checks are unavailable because no approved provider is configured.' } }; }
