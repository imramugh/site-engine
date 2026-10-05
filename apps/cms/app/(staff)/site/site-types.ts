export type AvailableReference = { kind: 'page' | 'section'; id: string; label: string; style?: 'link' | 'button' }
export type UnavailableReference = { kind: 'unavailable'; label: string; reason: string; style?: 'link' | 'button' }
export type Reference = AvailableReference | UnavailableReference
export type FooterReference = Omit<AvailableReference, 'style'> | Omit<UnavailableReference, 'style'>
export type FooterColumn =
  | { kind?: 'links'; heading: string; links: FooterReference[] }
  | { kind: 'section-pillars'; heading: string; sectionId: string }
  | { kind: 'contact'; heading: string; fields: Array<'phone' | 'email' | 'address' | 'linkedIn'> }
export type Navigation = { header: Reference[]; footer: { columns: FooterColumn[]; bottomLinks?: FooterReference[]; copyright?: string } }
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
  crawlerPolicy: { searchEngines: boolean; aiSearchAndAnswers: boolean; aiModelTraining: boolean } | null
}
export type Guide = {
  bannedPhrases: string[]
  preferredTerms: Array<{ avoid: string; prefer: string }>
  canadianSpelling: 'off' | 'warn'
  maximumSentenceWords: number
  minimumReadingEase: number
}
export type Redirect = { id: string; from: string; to: string; createdBy: string | null; hitCount: number; hash: string }
export type References = {
  pages: Array<{ id: string; title: string }>
  sections: Array<{ id: string; title: string; pillars: Array<{ id: string; title: string }> }>
  assets: Array<{ id: string; label: string; url?: string | null }>
}

export const emptyAddress: Address = { streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', addressCountry: 'CA' }
export const emptyLogos: Logos = { primaryLight: null, primaryDark: null, fullLockupLight: null, fullLockupDark: null, symbolLight: null, symbolDark: null }
export const emptyNavigation: Navigation = { header: [], footer: { columns: [] } }
