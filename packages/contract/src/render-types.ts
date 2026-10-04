import type { Page, Section } from './index.js';
export type PublicRoute = { path: string; page: Page; section: Section; ancestors: Page[]; breadcrumbs: { label: string; href: string }[]; canonicalPath: string };
export type RouteNavigation = {
  desktopSections: PublicRoute[];
  mobileSections: PublicRoute[];
  footerSections: PublicRoute[];
  footerServices: PublicRoute[];
};
export type RouteModel = { sections: Section[]; routes: PublicRoute[]; navigation: RouteNavigation; byPath: ReadonlyMap<string, PublicRoute>; redirects: ReadonlyMap<string, string>; warnings: string[] };
