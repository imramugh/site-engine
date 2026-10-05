import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { expect, test } from 'vitest'

const cms = fileURLToPath(new URL('..', import.meta.url))
test('production CLI migration creates usable notification receipts, user mutes, and lock references', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'notification-production-migration-'))
  try {
    const database = `file:${join(directory, 'cms.sqlite')}`
    const env = { ...process.env, NODE_ENV: 'production', DATABASE_URI: database, PAYLOAD_SECRET: 'notification-production-migration-secret' }
    const migrate = spawnSync(process.execPath, [resolve(cms, 'node_modules/payload/bin.js'), 'migrate', '--config', 'payload.config.ts'], { cwd: cms, env, encoding: 'utf8' })
    expect(migrate.status, migrate.stderr || migrate.stdout).toBe(0)
    const probe = join(directory, 'probe.mts')
    writeFileSync(probe, `import { getPayload } from ${JSON.stringify(resolve(cms, 'node_modules/payload/dist/index.js'))}; import config from ${JSON.stringify(resolve(cms, 'payload.config.ts'))}; const payload=await getPayload({config}); try { const user=await payload.create({collection:'users',data:{email:'migration-notify@example.test',name:'Migration',roles:['owner']},overrideAccess:true}); const preference=await payload.create({collection:'notification-user-preferences',data:{user:user.id,mutedKinds:['new-lead']},overrideAccess:true}); await payload.update({collection:'notification-user-preferences',id:preference.id,data:{mutedKinds:['new-job-application']},overrideAccess:true}); const outbox=await payload.create({collection:'notification-outbox',data:{kind:'new-lead',idempotencyKey:'migration-notification-outbox',state:'queued',payload:{},recipientRules:['owner'],recipients:[{type:'staff',id:user.id,email:user.email}],channels:['email'],availableAt:new Date().toISOString()},overrideAccess:true}); const delivery=await payload.create({collection:'notification-deliveries',data:{outbox:outbox.id,idempotencyKey:'migration-notification-delivery',recipient:{type:'staff',id:user.id,email:user.email},state:'queued',attempts:0,nextAttemptAt:new Date().toISOString()},overrideAccess:true}); const read=await payload.findByID({collection:'notification-deliveries',id:delivery.id,overrideAccess:true}); if(read.id!==delivery.id) throw new Error('delivery CRUD failed'); console.log('ok') } finally { await payload.destroy() }`)
    const run = spawnSync(process.execPath, [resolve(cms, 'node_modules/tsx/dist/cli.mjs'), probe], { cwd: cms, env, encoding: 'utf8' })
    expect(run.status, run.stderr || run.stdout).toBe(0)
    const sqlite = createClient({ url: database })
    for (const table of ['notification_deliveries', 'notification_user_preferences']) expect((await sqlite.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`)).rows).toHaveLength(1)
    const columns = await sqlite.execute("SELECT name FROM pragma_table_info('payload_locked_documents_rels') WHERE name IN ('notification_deliveries_id','notification_user_preferences_id')")
    expect(columns.rows.map((row) => row.name).sort()).toEqual(['notification_deliveries_id', 'notification_user_preferences_id'])
    for (const index of ['payload_locked_documents_rels_notification_deliveries_id_idx', 'payload_locked_documents_rels_notification_user_preferences_id_idx']) expect((await sqlite.execute(`SELECT name FROM sqlite_master WHERE type='index' AND name='${index}'`)).rows).toHaveLength(1)
    sqlite.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 120_000)
