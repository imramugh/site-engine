import type { Page, Section } from './index.js';
export type PublicRoute = { path: string; page: Page; section: Section; ancestors: Page[]; breadcrumbs: { label: string; href: string }[]; canonicalPath: string };
export type RouteModel = { routes: PublicRoute[]; byPath: ReadonlyMap<string, PublicRoute>; redirects: ReadonlyMap<string, string>; warnings: string[] };
