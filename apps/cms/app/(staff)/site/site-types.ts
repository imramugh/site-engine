export type Reference = { kind: 'page' | 'section'; id: string; label: string; style?: 'link' | 'button' }
export type Navigation = { header: Reference[]; footer: { columns: Array<{ heading: string; links: Omit<Reference, 'style'>[] }>; copyright?: string } }
export type Logos = { primaryLight: string | null; primaryDark: string | null; fullLockupLight: string | null; fullLockupDark: string | null; symbolLight: string | null; symbolDark: string | null }
export type Address = { streetAddress: string; addressLocality: string; addressRegion: string; postalCode: string; addressCountry: string }
export type Settings = {
  siteName: string
  legalName: string | null
  homepageId: string | null
  defaultLocale: 'en' | 'en-CA'
  organizationType: 'organization' | 'professional-service' | null
  logo: string | null
  logos: Logos | null
  contactEmail: string | null
  contactPhone: string | null
  address: Address | null
  linkedIn: string | null
  incident: { label: string; guidance: string } | null
  navigation: Navigation | null
  seoDescription: string | null
  searchEnabled: boolean
}
export type References = {
  pages: Array<{ id: string; title: string }>
  sections: Array<{ id: string; title: string }>
  assets: Array<{ id: string; label: string }>
}

export const emptyAddress: Address = { streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', addressCountry: 'CA' }
export const emptyLogos: Logos = { primaryLight: null, primaryDark: null, fullLockupLight: null, fullLockupDark: null, symbolLight: null, symbolDark: null }
export const emptyNavigation: Navigation = { header: [], footer: { columns: [] } }
