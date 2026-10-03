import type { Block, Page, PublicRoute, RouteModel, SiteSnapshot } from '@site-engine/contract';
import { deriveRoutes } from '@site-engine/engine';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };
type Schema = { '@context': 'https://schema.org'; '@graph': Array<Record<string, Json | undefined>> };

const absolute = (origin: string, path: string) => new URL(path, origin).href;
const visible = (page: Page) => page.blocks.filter((block) => !block.hidden);
const textBlocks = (blocks: readonly Block[]) => blocks.flatMap((block) => {
  if (block.type === 'richText') return [block.body];
  if ('body' in block && typeof block.body === 'string') return [block.body];
  return [];
});

export function publicModel(snapshot: SiteSnapshot, homepageId: string | undefined): RouteModel {
  if (!homepageId) throw new Error('A public snapshot requires a homepage ID.');
  return deriveRoutes(snapshot, homepageId);
}

export function sitemapXML(model: RouteModel, origin: string): string {
  const entries = model.routes.map((route) => {
    const updatedAt = route.page.updatedAt;
    return `<url><loc>${xml(absolute(origin, route.canonicalPath))}</loc>${updatedAt ? `<lastmod>${xml(new Date(updatedAt).toISOString())}</lastmod>` : ''}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>\n`;
}

function xml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }

function pageSchema(route: PublicRoute, origin: string): Record<string, Json | undefined> {
  const canonical = absolute(origin, route.canonicalPath);
  return {
    '@type': 'WebPage', '@id': `${canonical}#webpage`, url: canonical, name: route.page.title,
    description: route.page.seoDescription ?? route.page.summary,
    dateModified: route.page.updatedAt,
    ...(route.page.publishedAt ? { datePublished: route.page.publishedAt } : {}),
    inLanguage: 'en',
  };
}

function breadcrumbs(route: PublicRoute, origin: string): Record<string, Json> {
  return {
    '@type': 'BreadcrumbList', itemListElement: route.breadcrumbs.map((crumb, index) => ({
      '@type': 'ListItem', position: index + 1, name: crumb.label, item: absolute(origin, crumb.href),
    })),
  };
}

function faqSchema(page: Page): Record<string, Json> | undefined {
  const items = visible(page).filter((block): block is Extract<Block, { type: 'faq' }> => block.type === 'faq').flatMap((block) => block.items);
  return items.length ? { '@type': 'FAQPage', mainEntity: items.map((item) => ({ '@type': 'Question', name: item.question, acceptedAnswer: { '@type': 'Answer', text: item.answer } })) } : undefined;
}

function collectionSchema(route: PublicRoute, model: RouteModel, origin: string): Record<string, Json> | undefined {
  if (route.page.template !== 'listing') return undefined;
  const children = model.routes.filter((candidate) => candidate.page.parentId === route.page.id);
  return {
    '@type': 'CollectionPage', '@id': `${absolute(origin, route.canonicalPath)}#collection`,
    name: route.page.title, description: route.page.summary,
    mainEntity: { '@type': 'ItemList', itemListElement: children.map((child, index) => ({ '@type': 'ListItem', position: index + 1, url: absolute(origin, child.canonicalPath), name: child.page.title })) },
  };
}

function articleSchema(route: PublicRoute, origin: string): Record<string, Json> | undefined {
  if (route.page.template !== 'article' || !route.page.publishedAt || !route.page.updatedAt) return undefined;
  const canonical = absolute(origin, route.canonicalPath);
  return { '@type': 'Article', '@id': `${canonical}#article`, mainEntityOfPage: { '@id': `${canonical}#webpage` }, headline: route.page.title, description: route.page.seoDescription ?? route.page.summary, datePublished: route.page.publishedAt, dateModified: route.page.updatedAt };
}

function jobSchema(route: PublicRoute, origin: string, snapshot: SiteSnapshot): Record<string, Json> | undefined {
  const metadata = route.page.jobPosting;
  const description = textBlocks(visible(route.page)).join('\n\n');
  if (route.page.template !== 'job' || !metadata || !description || (metadata.validThrough && new Date(metadata.validThrough) <= new Date())) return undefined;
  const canonical = absolute(origin, route.canonicalPath);
  return { '@type': 'JobPosting', '@id': `${canonical}#job`, title: route.page.title, description, datePosted: metadata.datePosted, employmentType: metadata.employmentType, ...(metadata.validThrough ? { validThrough: metadata.validThrough } : {}), jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', ...metadata.location } }, hiringOrganization: { '@type': 'Organization', name: snapshot.settings.siteName, url: origin } };
}

export function schemaForRoute(route: PublicRoute, model: RouteModel, snapshot: SiteSnapshot, origin: string): Schema {
  const website = { '@type': 'Organization', '@id': `${origin}/#organization`, name: snapshot.settings.siteName, url: origin } as Record<string, Json>;
  const service = { '@type': 'ProfessionalService', '@id': `${origin}/#professional-service`, name: snapshot.settings.siteName, url: origin, parentOrganization: { '@id': `${origin}/#organization` } } as Record<string, Json>;
  return { '@context': 'https://schema.org', '@graph': [website, snapshot.settings.organizationType === 'professional-service' ? service : undefined, pageSchema(route, origin), breadcrumbs(route, origin), articleSchema(route, origin), faqSchema(route.page), jobSchema(route, origin, snapshot), collectionSchema(route, model, origin)].filter((item): item is Record<string, Json> => Boolean(item)) };
}

export function llmsText(model: RouteModel, snapshot: SiteSnapshot, origin: string): string {
  const pages = model.routes.slice(0, 50).map((route) => `- [${route.page.title}](${absolute(origin, route.canonicalPath)}): ${route.page.summary}`);
  return [`# ${snapshot.settings.siteName}`, '', 'Public, published site information generated from the current content snapshot.', '', '## Pages', ...pages, ''].join('\n');
}

export function machineReadablePages(model: RouteModel, snapshot: SiteSnapshot, origin: string): Json {
  return {
    version: 1, site: { name: snapshot.settings.siteName, url: origin }, pages: model.routes.map((route) => ({
      url: absolute(origin, route.canonicalPath), canonical: absolute(origin, route.canonicalPath), title: route.page.title,
      summary: route.page.summary, template: route.page.template, publishedAt: route.page.publishedAt, updatedAt: route.page.updatedAt,
      breadcrumbs: route.breadcrumbs.map((crumb) => ({ label: crumb.label, url: absolute(origin, crumb.href) })),
      text: textBlocks(visible(route.page)),
      faqs: visible(route.page).filter((block): block is Extract<Block, { type: 'faq' }> => block.type === 'faq').flatMap((block) => block.items.map((item) => ({ question: item.question, answer: item.answer }))),
    })),
  };
}
