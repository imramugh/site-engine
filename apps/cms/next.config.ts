import type { NextConfig } from 'next'
import { withPayload } from '@payloadcms/next/withPayload'

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  // Releases compiler buffers after webpack while retaining Next's full type check.
  experimental: {
    webpackMemoryOptimizations: true,
  },
}

const payloadConfig = withPayload(nextConfig)

// Payload adds Critical-CH globally. Browsers are allowed to repeat a navigation
// to satisfy that hint; repeating an OIDC start consumes the state cookie and
// correctly trips the single-flight throttle. Keep the non-critical preference
// hint, but never make it navigation-critical.
const payloadHeaders = payloadConfig.headers
payloadConfig.headers = async () => {
  const rules = payloadHeaders ? await payloadHeaders() : []
  return rules.map((rule) => ({
    ...rule,
    headers: rule.headers.filter((header) => header.key.toLowerCase() !== 'critical-ch'),
  }))
}

export default payloadConfig
