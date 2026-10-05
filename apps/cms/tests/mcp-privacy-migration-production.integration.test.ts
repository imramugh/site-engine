import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { expect, test } from 'vitest'

const cms = fileURLToPath(new URL('..', import.meta.url))

test('production CLI migration creates private MCP policy CRUD and lock relationship', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-privacy-production-migration-'))
  try {
    const database = `file:${join(directory, 'cms.sqlite')}`
    const env = { ...process.env, NODE_ENV: 'production' as const, DATABASE_URI: database, PAYLOAD_SECRET: 'mcp-privacy-production-migration-secret' }
    const migrate = spawnSync(process.execPath, [resolve(cms, 'node_modules/payload/bin.js'), 'migrate', '--config', 'payload.config.ts'], { cwd: cms, env, encoding: 'utf8' })
    expect(migrate.status, migrate.stderr || migrate.stdout).toBe(0)
    const probe = join(directory, 'probe.mts')
    writeFileSync(probe, `import { getPayload } from ${JSON.stringify(resolve(cms, 'node_modules/payload/dist/index.js'))}; import config from ${JSON.stringify(resolve(cms, 'payload.config.ts'))}; const payload=await getPayload({config}); try { const policy=await payload.create({collection:'mcp-privacy-settings',data:{key:'active',hidePhone:true},overrideAccess:true}); await payload.update({collection:'mcp-privacy-settings',id:policy.id,data:{hidePhone:false},overrideAccess:true}); const read=await payload.findByID({collection:'mcp-privacy-settings',id:policy.id,overrideAccess:true}); if(read.hidePhone!==false) throw new Error('policy CRUD failed'); console.log('ok') } finally { await payload.destroy() }`)
    const run = spawnSync(process.execPath, [resolve(cms, 'node_modules/tsx/dist/cli.mjs'), probe], { cwd: cms, env, encoding: 'utf8' })
    expect(run.status, run.stderr || run.stdout).toBe(0)
    const sqlite = createClient({ url: database })
    expect((await sqlite.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_privacy_settings'" )).rows).toHaveLength(1)
    expect((await sqlite.execute("SELECT name FROM pragma_table_info('payload_locked_documents_rels') WHERE name='mcp_privacy_settings_id'" )).rows).toHaveLength(1)
    expect((await sqlite.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='payload_locked_documents_rels_mcp_privacy_settings_id_idx'" )).rows).toHaveLength(1)
    sqlite.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 120_000)
