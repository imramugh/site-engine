import type { Payload, PayloadRequest } from 'payload'
import { freshStaff, hasRole, type Role } from './access'
import { withPayloadTransaction } from './auth-transaction'
import { captureReviewedRollback } from './reviewed-rollback'
import type { CapturedChange } from './editorial'
import { fieldDiffs } from './field-diffs'
import { SiteSnapshotSchema } from '@site-engine/contract'
import { changeSetHash } from './publishing'

type Actor = { id: string; name?: string | null; email?: string | null; roles?: Role[] | null; disabled?: boolean | null }
const relationID=(value:unknown)=>typeof value==='string'?value:value&&typeof value==='object'&&'id'in value?String((value as {id:unknown}).id):undefined
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
const words=(value:string)=>value.replaceAll(/[._-]+/g,' ').replace(/\b\w/g,letter=>letter.toUpperCase())
const category=(event:string)=>event.startsWith('editorial.')?'editorial':event.startsWith('identity.')?'identity':event.startsWith('integration.')?'integration':event.startsWith('mcp.')||event.startsWith('ai.')?'assistant':event.startsWith('block_gallery.')||event.startsWith('media.')?'media':event.startsWith('lead.')||event.startsWith('inquiry.')?'lead':event.startsWith('application.')?'career':event.startsWith('theme.')||event.startsWith('site.')?'site':'system'
const presentation=(event:string,detail:Record<string,unknown>,setName?:string)=>{
  const exact:Record<string,string>={
    'editorial.change_set_approved':`${setName??'Change set'} approved for publishing`,
    'editorial.change_set_submitted':`${setName??'Change set'} submitted for review`,
    'editorial.change_set_request-changes':`Changes requested for ${setName??'change set'}`,
    'editorial.change_captured':'Draft content updated',
    'editorial.snapshot_imported':setName??'Reviewed snapshot prepared',
    'identity.signed_in':'Signed in', 'identity.roles_changed':'User roles changed', 'identity.disabled':'User access disabled',
    'integration.credential_rotated':'Integration credential updated','integration.connection_tested':'Integration connection tested','integration.revoked':'Integration disconnected',
    'mcp.request':'Connected assistant used the workspace','lead.updated':'Lead updated','lead.created':'Lead created','application.stage_changed':'Application status changed',
  }
  const title=exact[event]??words(event)
  const status=/failed|denied|rejected|unavailable/.test(event)?'Needs attention':/submitted|request-changes/.test(event)?'In review':/approved|published|completed/.test(event)?'Complete':'Recorded'
  const source=event.startsWith('mcp.')||event.startsWith('ai.')?'assistant':detail.actor?'person':'system'
  return{title,status,source,category:category(event)}
}
const privateField = /(?:password|credential|token|secret|cookie|seed|privatekey|apikey)/i
const technicalFields = new Set(['updatedAt', 'createdAt', 'beforeHash', 'afterHash'])
function contentValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(contentValues)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !privateField.test(key) && !technicalFields.has(key)).map(([key, item]) => [key, contentValues(item)]))
  return value
}
const displayValue = (value: unknown): string => {
  if (value == null || value === '') return '—'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
}
function reviewedDiff(changes: Array<Record<string, unknown>>) {
  const allowed = changes.filter(change => ['pages', 'sections', 'site-settings', 'theme-settings', 'style-guides', 'assets', 'redirects'].includes(String(change.collection)))
  let truncated = false
  const entries = allowed.flatMap(change => {
    const title = record(change.after).title ?? record(change.before).title ?? words(String(change.collection))
    const differences = fieldDiffs(contentValues(change.before), contentValues(change.after), 200)
    if (differences.some(([field]) => field === 'Additional changes (complete values)')) truncated = true
    return differences.filter(([field]) => field !== 'Additional changes (complete values)' && field !== 'id' && !field.endsWith(' › id'))
      .map(([field, before, after]) => ({ record: String(title), field: words(field), before: displayValue(before), after: displayValue(after) }))
  })
  return entries.length ? { label: 'Reviewed changes', entries: entries.slice(0, 200), truncated: truncated || entries.length > 200, pages: allowed.filter(change => change.collection === 'pages').length } : null
}
type RollbackMode = 'release' | 'change'
type RollbackRequest = { mode?: RollbackMode; changeKeys?: string[] }
const rollbackKey = (change: Record<string, unknown>) => `${String(change.collection)}:${String(change.id)}`
const supportedCollection = (value: unknown) => ['pages', 'sections', 'redirects', 'assets', 'style-guides', 'site-settings', 'theme-settings'].includes(String(value))
const selectedChanges = (set: Record<string, unknown> | undefined, outbox: Record<string, unknown>, request: RollbackRequest = {}) => {
  const changes = Array.isArray(set?.changes) ? set!.changes.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : []
  const included = Array.isArray(outbox.includedChangeKeys) ? outbox.includedChangeKeys.filter((key): key is string => typeof key === 'string') : []
  if (!included.length) throw new Error('This release has no approved captured changes to roll back.')
  const approved = changes.filter(change => included.includes(rollbackKey(change)))
  if (approved.length !== included.length || approved.some(change => !supportedCollection(change.collection))) throw new Error('This release includes an approved change that requires a manual reviewed change.')
  if (request.mode === 'change') {
    if (!Array.isArray(request.changeKeys) || request.changeKeys.length !== 1 || new Set(request.changeKeys).size !== 1) throw new Error('Choose exactly one approved change to roll back.')
    const selected = approved.filter(change => rollbackKey(change) === request.changeKeys![0])
    if (selected.length !== 1) throw new Error('The selected change was not included in this release.')
    return selected
  }
  if (request.mode && request.mode !== 'release') throw new Error('Choose a supported rollback scope.')
  return approved
}

export async function projectChangeLog(payload:Payload,events:Array<Record<string,any>>){
  const changeSetIDs=[...new Set(events.flatMap(item=>{const id=relationID(record(item.detail).changeSet);return id?[id]:[]}))]
  const [sets,releases,previewJobs]=await Promise.all([
    changeSetIDs.length?payload.find({collection:'change-sets',where:{id:{in:changeSetIDs}},limit:200,depth:0,overrideAccess:true}):Promise.resolve({docs:[]}),
    payload.find({collection:'published-releases',sort:'-sequence',limit:200,depth:2,overrideAccess:true}),
    changeSetIDs.length?payload.find({collection:'preview-render-jobs',where:{changeSet:{in:changeSetIDs}},sort:'-completedAt',limit:200,depth:0,overrideAccess:true}):Promise.resolve({docs:[]}),
  ])
  const bySet=new Map(sets.docs.map(set=>[String(set.id),set]))
  const previewByID=new Map((previewJobs.docs as Array<Record<string,unknown>>).map(job=>[String(job.id),job]))
  const releaseBySet=new Map<string,any>()
  for(const release of releases.docs){const outbox=record(release.outbox);const id=relationID(outbox.changeSet);if(id)releaseBySet.set(id,release)}
  return events.map(item=>{
    const detail=record(item.detail),setID=relationID(detail.changeSet),set=setID?bySet.get(setID):undefined
    const actor=record(item.actor),event=String(item.event),view=presentation(event,{...detail,actor:relationID(item.actor)},typeof set?.name==='string'?set.name:undefined)
    const changes=Array.isArray(set?.changes)?set.changes as Array<Record<string,unknown>>:[]
    const diff=reviewedDiff(changes)
    const preview=record(set?.preview),eventPreviewID=typeof detail.previewJobID==='string'?detail.previewJobID:undefined,job=eventPreviewID?previewByID.get(eventPreviewID):typeof preview.jobID==='string'?previewByID.get(preview.jobID):undefined
    const evidenceManifest=record(job?.evidenceManifest), screenshotState=evidenceManifest.state
    const evidence=job&&set&&job.status==='completed'&&typeof job.artifactDigest==='string'&&screenshotState==='available'
      ? { label:'Open immutable screenshot evidence',href:`/api/auth/preview/evidence/${encodeURIComponent(String(job.id))}/proposed` }
      : screenshotState==='unavailable' ? { label:'Screenshot evidence unavailable',href:'' } : null
    const release=setID?releaseBySet.get(setID):undefined; let approved:Record<string,unknown>[]=[];let supportNote=''
    if(release&&set){try{approved=selectedChanges(set as unknown as Record<string,unknown>,record(release.outbox))}catch(error){supportNote=error instanceof Error?error.message:'Rollback is unavailable.'}}
    const canRollback=Boolean(release&&Number(release.sequence)>1&&!supportNote)
    return{id:String(item.id),event,createdAt:String(item.createdAt),who:typeof actor.name==='string'?actor.name:typeof actor.email==='string'?actor.email:view.source==='assistant'?'Connected assistant':'System',via:view.source==='assistant'?(event.startsWith('mcp.')?'MCP':'Admin assistant'):relationID(item.actor)?'Admin':'Automated process',...view,detail:diff?`${changes.length} ${changes.length===1?'record':'records'} changed`:set?.name??'Activity recorded',diff,evidence,rollback:release?{releaseID:String(release.id),sequence:Number(release.sequence),enabled:canRollback,note:canRollback?'Creates a draft change set for review. Nothing publishes automatically.':supportNote||'No earlier release is available.',changes:approved.map(change=>({key:rollbackKey(change),label:`${words(String(change.collection))} · ${String(record(change.after).title??record(change.before).title??change.id)}`}))}:null}
  })
}

export async function prepareReviewedRollbackCore(payload:Payload,req:PayloadRequest,actor:Actor,releaseID:string,request:RollbackRequest={}){
  if(!hasRole(actor,['owner','approver']))throw new Error('Owner or Approver access is required.')
  if(!req.transactionID)throw new Error('Rollback preparation must run inside a database transaction.')
  const latest=(await payload.find({collection:'published-releases',sort:'-sequence',limit:1,depth:1,overrideAccess:true,req})).docs[0]
  const selected=latest&&String(latest.id)===releaseID?latest:await payload.findByID({collection:'published-releases',id:releaseID,depth:1,overrideAccess:true,req})
  if(!latest||!selected)throw new Error('Choose an existing immutable release.')
  const outbox=record(selected.outbox),setID=relationID(outbox.changeSet)
  const set=setID?await payload.findByID({collection:'change-sets',id:setID,depth:0,overrideAccess:true,req}):undefined
  const changes=selectedChanges(set as unknown as Record<string,unknown>,outbox,request)
  const sequence=Number(selected.sequence);const previous=(await payload.find({collection:'published-releases',where:{sequence:{less_than:sequence}},sort:'-sequence',limit:1,depth:1,overrideAccess:true,req})).docs[0]
  const currentSnapshot=record(latest.snapshot),previousSnapshot=record(previous?.snapshot)
  if(!previous||!currentSnapshot.manifest||!previousSnapshot.manifest)throw new Error('An earlier immutable release is required for rollback.')
  return captureReviewedRollback(payload,req,actor.id,request.mode==='change'?`Rollback change from release #${sequence}`:`Rollback release #${sequence}`,SiteSnapshotSchema.parse(currentSnapshot.manifest),changes as CapturedChange[],SiteSnapshotSchema.parse(previousSnapshot.manifest))
}

export async function prepareReviewedRollback(payload:Payload,actor:Actor,headers:Headers,releaseID:string,request:RollbackRequest={}){
  if(!(await freshStaff(['owner','approver'])({req:{payload,user:actor,headers} as never})))throw new Error('Fresh Owner or Approver authentication is required.')
  return withPayloadTransaction(payload,async(req:PayloadRequest)=>{req.user=actor as never;req.headers=headers;return prepareReviewedRollbackCore(payload,req,actor,releaseID,request)})
}
