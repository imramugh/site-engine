import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nginxRedirectInclude } from '../scripts/redirect-artifact.mjs'

const exec = promisify(execFile)
const image = 'nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6'
const name = `site-engine-redirect-${process.pid}`
let directory = ''

describe('ENG-013 Nginx redirect artifact', () => {
  beforeAll(async () => {
    await exec('docker', ['version', '--format', '{{.Server.Version}}'])
    directory = await mkdtemp(join(tmpdir(), 'site-engine-nginx-'))
    await chmod(directory, 0o755)
    await writeFile(join(directory, 'redirects.nginx.conf'), nginxRedirectInclude({
      settings: { contractVersion: '1.0.0', siteName: 'Sample', defaultLocale: 'en', homepageId: '11111111-1111-4111-8111-111111111111', sections: [{ id: '22222222-2222-4222-8222-222222222222', name: 'General', slug: 'general', allowedTemplates: ['landing'], pageIds: ['11111111-1111-4111-8111-111111111111'] }] },
      pages: [{ id: '11111111-1111-4111-8111-111111111111', sectionId: '22222222-2222-4222-8222-222222222222', title: 'Home', summary: 'A synthetic home page with a valid descriptive summary.', slug: 'home', template: 'landing', status: 'published', blocks: [{ id: '33333333-3333-4333-8333-333333333333', type: 'hero', heading: 'Home', body: 'Synthetic body', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }], media: [], redirects: [{ from: '/legacy', to: '/general', status: 301 }], changeSets: [],
    }))
    await writeFile(join(directory, 'nginx.conf'), `pid /tmp/nginx.pid;\nevents {}\nhttp { server { listen 8080; absolute_redirect off; include /etc/nginx/redirects.nginx.conf; location / { return 200 'static'; } } }\n`)
    await exec('docker', ['run', '--pull=missing', '-d', '--name', name, '-p', '127.0.0.1:4600:8080', '-v', `${directory}/nginx.conf:/etc/nginx/nginx.conf:ro`, '-v', `${directory}/redirects.nginx.conf:/etc/nginx/redirects.nginx.conf:ro`, image])
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { if ((await fetch('http://127.0.0.1:4600/')).status === 200) return } catch { /* container is starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const logs = await exec('docker', ['logs', name]).then((result) => `${result.stdout}${result.stderr}`).catch(() => 'container logs unavailable')
    throw new Error(`Nginx did not become ready on port 4600: ${logs}`)
  }, 60_000)
  afterAll(async () => { await exec('docker', ['rm', '-f', name]).catch(() => undefined); if (directory) await rm(directory, { recursive: true, force: true }) })

  it('serves a single permanent redirect over real HTTP', async () => {
    const response = await fetch('http://127.0.0.1:4600/legacy', { redirect: 'manual' })
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('/general')
  })
})
