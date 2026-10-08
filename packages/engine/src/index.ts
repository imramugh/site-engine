import { SiteSnapshotSchema, ThemeInstallSchema, type Page, type Section, type SiteSnapshot, type Block, type PublicRoute, type RouteModel } from '@site-engine/contract';
export { validateThemePackage } from './theme-package.js';
export type { PublicRoute, RouteModel } from '@site-engine/contract';

export function validateThemeInstall(input: unknown) { return ThemeInstallSchema.safeParse(input); }
export function visibleBlocks(snapshot: SiteSnapshot): Block[] { return snapshot.pages.filter((page) => page.status === 'published').flatMap((page) => page.blocks).filter((block) => !block.hidden); }


function ancestorsFor(page: Page, pages: ReadonlyMap<string, Page>): Page[] {
  const ancestors: Page[] = [];
  const seen = new Set<string>([page.id]);
  let parentId = page.parentId;
  while (parentId) {
    if (seen.has(parentId)) throw new Error(`Page ${page.id} has cyclic ancestry`);
    const parent = pages.get(parentId);
    if (!parent) throw new Error(`Page ${page.id} references missing parent ${parentId}`);
    seen.add(parentId); ancestors.unshift(parent); parentId = parent.parentId;
  }
  return ancestors;
}

/** Derives static public paths from the content tree; never infers routes from a theme. */
export function deriveRoutes(input: SiteSnapshot, homepageId = input.settings.homepageId): RouteModel {
  const snapshot = SiteSnapshotSchema.parse(input);
  const pages = new Map(snapshot.pages.map((page) => [page.id, page]));
  const sections = new Map(snapshot.settings.sections.map((section) => [section.id, section]));
  const routes: PublicRoute[] = [];
  const byPath = new Map<string, PublicRoute>();
  const warnings: string[] = [];
  const published = snapshot.pages.filter((page) => page.status === 'published');
  if (!homepageId) throw new Error('A complete site requires settings.homepageId');
  const selectedHomepage = homepageId;
  const homepage = pages.get(selectedHomepage);
  if (!homepage || homepage.status !== 'published' || homepage.template !== 'landing') throw new Error('Homepage must reference a published landing page');
  for (const page of published) {
    const section = sections.get(page.sectionId);
    if (!section) throw new Error(`Page ${page.id} references missing section ${page.sectionId}`);
    const ancestors = ancestorsFor(page, pages);
    if (ancestors.some((ancestor) => ancestor.status !== 'published')) continue;
    const pathAncestors = ancestors.filter((ancestor) => ancestor.id !== section.landingPageId);
    const path = page.id === selectedHomepage ? '/' : page.id === section.landingPageId ? `/${section.slug}` : `/${[section.slug, ...pathAncestors.map((ancestor) => ancestor.slug), page.slug].filter(Boolean).join('/')}`;
    if (byPath.has(path)) throw new Error(`Duplicate public path ${path}`);
    const ancestorCrumbs = pathAncestors.map((ancestor) => ({ label: ancestor.title, href: `/${[section.slug, ...ancestorsFor(ancestor, pages).filter((item) => item.id !== section.landingPageId).map((item) => item.slug), ancestor.slug].filter(Boolean).join('/')}` }));
    const breadcrumbs = [{ label: 'Home', href: '/' }, ...ancestorCrumbs, ...(path === '/' ? [] : [{ label: page.title, href: path }])];
    const route: PublicRoute = { path, page, section, ancestors, breadcrumbs, canonicalPath: path };
    routes.push(route); byPath.set(path, route);
  }
  if (!byPath.has('/')) throw new Error('Homepage cannot be hidden by an unpublished ancestor');
  for (const section of snapshot.settings.sections) if (section.pageIds.length > 8) warnings.push(`Section ${section.slug} has more than eight pages; excess pages are footer-only.`);
  const redirects = new Map<string, string>();
  for (const redirect of snapshot.redirects) { if (byPath.has(redirect.from)) throw new Error(`Redirect ${redirect.from} conflicts with a published route`); if (!byPath.has(redirect.to)) warnings.push(`Redirect ${redirect.from} points to an unavailable route ${redirect.to}`); else redirects.set(redirect.from, redirect.to); }
  return { routes, byPath, redirects, warnings };
}

export function childrenOf(route: PublicRoute, model: RouteModel): PublicRoute[] { return model.routes.filter((candidate) => candidate.page.parentId === route.page.id); }
export function serviceNavigation(model: RouteModel): PublicRoute[] { return model.routes.filter((route) => route.page.template === 'service').sort((a, b) => a.page.title.localeCompare(b.page.title)); }

export type ResolvedNavigationItem = { label: string; style: 'link' | 'button'; href?: string; unavailableReason?: string };
export type ResolvedFooterColumn =
  | { kind: 'links' | 'section-pillars'; heading: string; items: ResolvedNavigationItem[] }
  | { kind: 'contact'; heading: string; items: Array<{ field: 'phone' | 'email' | 'address' | 'linkedIn'; label: string; value: string; href?: string }> };
export type ResolvedSiteNavigation = { header: ResolvedNavigationItem[]; footer: { columns: ResolvedFooterColumn[]; bottomLinks: ResolvedNavigationItem[]; copyright?: string } };

/** Resolves reviewed navigation without themes reimplementing ordering, missing-target,
 * contact visibility, or current-year behavior. Unavailable entries deliberately
 * have no href and remain present so a theme can explain their state accessibly. */
export function resolveSiteNavigation(input: SiteSnapshot, year = new Date().getUTCFullYear()): ResolvedSiteNavigation {
  const snapshot = SiteSnapshotSchema.parse(input);
  const navigation = snapshot.settings.navigation;
  if (!navigation) return { header: [], footer: { columns: [], bottomLinks: [] } };
  const model = deriveRoutes(snapshot);
  const routeByPage = new Map(model.routes.map(route => [route.page.id, route]));
  const sections = new Map(snapshot.settings.sections.map(section => [section.id, section]));
  const pages = new Map(snapshot.pages.map(page => [page.id, page]));
  const resolveReference = (reference: (typeof navigation.header)[number] | NonNullable<typeof navigation.footer.bottomLinks>[number]): ResolvedNavigationItem => {
    const style = 'style' in reference ? reference.style : 'link';
    if (reference.kind === 'unavailable') return { label: reference.label, style, unavailableReason: reference.reason };
    const pageID = reference.kind === 'page' ? reference.id : sections.get(reference.id)?.landingPageId;
    const href = pageID ? routeByPage.get(pageID)?.path : undefined;
    return href ? { label: reference.label, style, href } : { label: reference.label, style, unavailableReason: 'This destination is not published.' };
  };
  const columns: ResolvedFooterColumn[] = navigation.footer.columns.map(column => {
    if (column.kind === 'section-pillars') {
      const section = sections.get(column.sectionId)!;
      const items = section.pageIds.flatMap(pageID => {
        const page = pages.get(pageID); const route = routeByPage.get(pageID);
        const isRootPillar = !page?.parentId || page.parentId === section.landingPageId;
        return page?.status === 'published' && page.template === 'pillar' && isRootPillar && route ? [{ label: page.title, style: 'link' as const, href: route.path }] : [];
      });
      return { kind: 'section-pillars', heading: column.heading, items };
    }
    if (column.kind === 'contact') {
      const address = snapshot.settings.address;
      const values = {
        phone: snapshot.settings.contactPhone ? { label: 'Phone', value: snapshot.settings.contactPhone, href: `tel:${snapshot.settings.contactPhone.replace(/[^+\d]/g, '')}` } : undefined,
        email: snapshot.settings.contactEmail ? { label: 'Email', value: snapshot.settings.contactEmail, href: `mailto:${snapshot.settings.contactEmail}` } : undefined,
        address: address ? { label: 'Address', value: [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode, address.addressCountry].filter(Boolean).join(', ') } : undefined,
        linkedIn: snapshot.settings.linkedIn ? { label: 'LinkedIn', value: snapshot.settings.linkedIn, href: snapshot.settings.linkedIn } : undefined,
      } as const;
      return { kind: 'contact', heading: column.heading, items: column.fields.flatMap(field => values[field] ? [{ field, ...values[field]! }] : []) };
    }
    return { kind: 'links', heading: column.heading, items: column.links.map(resolveReference) };
  });
  return {
    header: navigation.header.map(resolveReference),
    footer: {
      columns,
      bottomLinks: (navigation.footer.bottomLinks ?? []).map(resolveReference),
      ...(navigation.footer.copyright ? { copyright: navigation.footer.copyright.replace('{year}', String(year)) } : {}),
    },
  };
}
export {
  effectiveMotion,
  motionPreferenceKey,
  mountMotionRuntime,
  resolveDeclaredMotionPreset,
  resolveMotionPreset,
  type EffectiveMotion,
  type MotionRuntimeOptions,
  type MotionPreference,
  type ResolvedMotionPreset,
} from './motion.js';
export { buildSearchIndex, type SearchDocument, type SearchIndex } from './search.js';
