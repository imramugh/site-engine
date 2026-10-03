import type { NextConfig } from 'next'
import { withPayload } from '@payloadcms/next/withPayload'

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
}

export default withPayload(nextConfig)
