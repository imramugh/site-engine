/** Browser-safe policy helpers for the optional first-party analytics hook. */
export const defaultAnalyticsEvents = [
  'page_view',
  'primary_cta',
  'navigation',
  'phone_tap',
  'form_accepted',
  'form_failed',
] as const;
export type AnalyticsEvent = (typeof defaultAnalyticsEvents)[number];
export type Attribution = 'direct' | 'search' | 'referral' | 'ai_assistant';
export type AnalyticsForm = 'inquiry' | 'application';
export type AnalyticsConfig = Readonly<{
  endpoint: string;
  events: readonly AnalyticsEvent[];
  navigationPaths: readonly string[];
  primaryCtaPaths: readonly string[];
}>;
export type AnalyticsConfigInput = Readonly<{
  endpoint?: unknown;
  events?: unknown;
  navigationPaths?: unknown;
  primaryCtaPaths?: unknown;
}>;
const eventNames = new Set<string>(defaultAnalyticsEvents);
const attributionNames = new Set<string>([
  'direct',
  'search',
  'referral',
  'ai_assistant',
]);
const formNames = new Set<string>(['inquiry', 'application']);
const policyOrigin = 'https://analytics-policy.invalid';
const sourceAttribution: Readonly<Record<string, Attribution>> = {
  direct: 'direct',
  google: 'search',
  bing: 'search',
  duckduckgo: 'search',
  search: 'search',
  chatgpt: 'ai_assistant',
  perplexity: 'ai_assistant',
  claude: 'ai_assistant',
  copilot: 'ai_assistant',
  gemini: 'ai_assistant',
  referral: 'referral',
};
const hostAttribution: Readonly<Record<string, Attribution>> = Object.assign(
  Object.create(null),
  {
    'google.com': 'search',
    'www.google.com': 'search',
    'bing.com': 'search',
    'www.bing.com': 'search',
    'duckduckgo.com': 'search',
    'www.duckduckgo.com': 'search',
    'chatgpt.com': 'ai_assistant',
    'www.chatgpt.com': 'ai_assistant',
    'chat.openai.com': 'ai_assistant',
    'perplexity.ai': 'ai_assistant',
    'www.perplexity.ai': 'ai_assistant',
    'claude.ai': 'ai_assistant',
    'www.claude.ai': 'ai_assistant',
    'copilot.microsoft.com': 'ai_assistant',
    'gemini.google.com': 'ai_assistant',
  },
);
function jsonArray(value: unknown): string[] | undefined {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(parsed) &&
    parsed.every((entry) => typeof entry === 'string')
    ? parsed
    : undefined;
}
function canonicalPath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
function staticPath(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  try {
    const parsed = new URL(path, policyOrigin);
    return parsed.origin === policyOrigin &&
      parsed.pathname === path &&
      !parsed.search &&
      !parsed.hash
      ? path
      : undefined;
  } catch {
    return undefined;
  }
}
function approvedPaths(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  const paths = jsonArray(value);
  if (!paths) return undefined;
  const result: string[] = [];
  for (const path of paths) {
    if (!staticPath(path)) return undefined;
    if (!result.includes(path)) result.push(path);
  }
  return result;
}
export function parseAnalyticsConfig(
  input: AnalyticsConfigInput,
): AnalyticsConfig | undefined {
  if (typeof input.endpoint !== 'string') return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    return undefined;
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
    return undefined;
  const events =
    input.events === undefined
      ? [...defaultAnalyticsEvents]
      : jsonArray(input.events);
  const navigationPaths = approvedPaths(input.navigationPaths);
  const primaryCtaPaths = approvedPaths(input.primaryCtaPaths);
  if (
    !events ||
    !events.every((event) => eventNames.has(event)) ||
    !navigationPaths ||
    !primaryCtaPaths
  )
    return undefined;
  return {
    endpoint: endpoint.href,
    events: [...new Set(events)] as AnalyticsEvent[],
    navigationPaths,
    primaryCtaPaths,
  };
}
export function analyticsConsentStorageKey(endpoint: string): string {
  return `site-analytics-consent:${encodeURIComponent(endpoint)}`;
}
export function classifyAttribution(
  input: Readonly<{ search: string; referrer: string; currentOrigin: string }>,
): Attribution | undefined {
  let parameters: URLSearchParams;
  try {
    parameters = new URLSearchParams(input.search);
  } catch {
    return undefined;
  }
  if (parameters.has('utm_source')) {
    const source = parameters.get('utm_source')?.trim().toLowerCase();
    return source && Object.hasOwn(sourceAttribution, source)
      ? sourceAttribution[source]
      : undefined;
  }
  if (!input.referrer) return 'direct';
  let referrer: URL;
  let current: URL;
  try {
    referrer = new URL(input.referrer);
    current = new URL(input.currentOrigin);
  } catch {
    return undefined;
  }
  if (
    referrer.origin === current.origin ||
    (referrer.protocol !== 'http:' && referrer.protocol !== 'https:')
  )
    return undefined;
  const host = referrer.hostname.toLowerCase().replace(/\.$/, '');
  return Object.hasOwn(hostAttribution, host)
    ? hostAttribution[host]
    : 'referral';
}
export function createAnalyticsPayload(
  event: unknown,
  path: unknown,
  attribution?: unknown,
  form?: unknown,
): Readonly<Record<string, string>> | undefined {
  const safePath = staticPath(path);
  if (typeof event !== 'string' || !eventNames.has(event) || !safePath)
    return undefined;
  if (
    attribution !== undefined &&
    (typeof attribution !== 'string' || !attributionNames.has(attribution))
  )
    return undefined;
  const conversion = event === 'form_accepted' || event === 'form_failed';
  if (
    conversion !== (form !== undefined) ||
    (form !== undefined && (typeof form !== 'string' || !formNames.has(form)))
  )
    return undefined;
  const payload: Record<string, string> = { event, path: safePath };
  if (attribution !== undefined) payload.attribution = attribution;
  if (form !== undefined) payload.form = form;
  return payload;
}
export function classifyConversion(
  detail: unknown,
):
  | Readonly<{ event: 'form_accepted' | 'form_failed'; form: AnalyticsForm }>
  | undefined {
  if (!detail || typeof detail !== 'object') return undefined;
  const candidate = detail as { form?: unknown; accepted?: unknown };
  if (
    typeof candidate.form !== 'string' ||
    !formNames.has(candidate.form) ||
    typeof candidate.accepted !== 'boolean'
  )
    return undefined;
  return {
    event: candidate.accepted ? 'form_accepted' : 'form_failed',
    form: candidate.form as AnalyticsForm,
  };
}
export function isApprovedNavigation(
  input: Readonly<{
    sameOrigin: boolean;
    inNavigation: boolean;
    pathname: string;
    config: AnalyticsConfig;
  }>,
): boolean {
  return (
    input.sameOrigin &&
    input.inNavigation &&
    input.config.navigationPaths.some(
      (path) => canonicalPath(path) === canonicalPath(input.pathname),
    )
  );
}
export function isApprovedPrimaryCta(
  input: Readonly<{
    sameOrigin: boolean;
    markedPrimary: boolean;
    pathname: string;
    config: AnalyticsConfig;
  }>,
): boolean {
  return (
    input.sameOrigin &&
    (input.markedPrimary ||
      input.config.primaryCtaPaths.some(
        (path) => canonicalPath(path) === canonicalPath(input.pathname),
      ))
  );
}
export function isPhoneLink(protocol: string): boolean {
  return protocol === 'tel:';
}
