import type { Payload, PayloadRequest } from 'payload'
import { freshStaff, type Role } from './access'
import { withPayloadTransaction } from './auth-transaction'
import { importReviewedSnapshot } from './reviewed-snapshot-import'

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
const changedFields=(before:unknown,after:unknown)=>{const a=record(before),b=record(after);return [...new Set([...Object.keys(a),...Object.keys(b)])].filter(key=>!['id','updatedAt','createdAt'].includes(key)&&JSON.stringify(a[key])!==JSON.stringify(b[key]))}
const rollbackSupported=(set:Record<string,unknown>|undefined)=>Array.isArray(set?.changes)&&set.changes.length>0&&(set.changes as Array<Record<string,unknown>>).every(change=>['pages','sections','redirects','site-settings'].includes(String(change.collection))&&Boolean(change.before)&&Boolean(change.after))

export async function projectChangeLog(payload:Payload,events:Array<Record<string,any>>){
  const changeSetIDs=[...new Set(events.flatMap(item=>{const id=relationID(record(item.detail).changeSet);return id?[id]:[]}))]
  const [sets,releases]=await Promise.all([
    changeSetIDs.length?payload.find({collection:'change-sets',where:{id:{in:changeSetIDs}},limit:200,depth:0,overrideAccess:true}):Promise.resolve({docs:[]}),
    payload.find({collection:'published-releases',sort:'-sequence',limit:200,depth:2,overrideAccess:true}),
  ])
  const bySet=new Map(sets.docs.map(set=>[String(set.id),set]))
  const releaseBySet=new Map<string,any>()
  for(const release of releases.docs){const outbox=record(release.outbox);const id=relationID(outbox.changeSet);if(id)releaseBySet.set(id,release)}
  const latestSequence=Math.max(0,...releases.docs.map(release=>Number(release.sequence)))
  return events.map(item=>{
    const detail=record(item.detail),setID=relationID(detail.changeSet),set=setID?bySet.get(setID):undefined
    const actor=record(item.actor),event=String(item.event),view=presentation(event,{...detail,actor:relationID(item.actor)},typeof set?.name==='string'?set.name:undefined)
    const changes=Array.isArray(set?.changes)?set.changes as Array<Record<string,unknown>>:[]
    const safeChanges=changes.filter(change=>['pages','sections','site-settings','theme-settings','assets','redirects'].includes(String(change.collection))).map(change=>({collection:String(change.collection),fields:changedFields(change.before,change.after)})).filter(change=>change.fields.length)
    const release=setID?releaseBySet.get(setID):undefined;const supported=rollbackSupported(set as unknown as Record<string,unknown>|undefined);const canRollback=Boolean(release&&Number(release.sequence)===latestSequence&&latestSequence>1&&supported)
    return{id:String(item.id),event,createdAt:String(item.createdAt),who:typeof actor.name==='string'?actor.name:typeof actor.email==='string'?actor.email:view.source==='assistant'?'Connected assistant':'System',via:view.source==='assistant'?(event.startsWith('mcp.')?'MCP':'Admin assistant'):relationID(item.actor)?'Admin':'Automated process',...view,detail:safeChanges.length?`${safeChanges.length} ${safeChanges.length===1?'record':'records'} changed`:set?.name??'Activity recorded',diff:safeChanges.length?{label:'Reviewed changes',before:'Previous values',after:`Updated ${safeChanges.flatMap(change=>change.fields).slice(0,5).map(words).join(', ')}`,pages:safeChanges.filter(change=>change.collection==='pages').length}:null,rollback:release?{releaseID:String(release.id),sequence:Number(release.sequence),enabled:canRollback,note:canRollback?'Creates a draft change set for review. Nothing publishes automatically.':!supported?'This release added, removed, or changed records that require a manual reviewed change.':'A newer release exists or no earlier release is available.'}:null}
  })
}

export async function prepareReviewedRollback(payload:Payload,actor:Actor,headers:Headers,releaseID:string){
  if(!(await freshStaff(['owner'])({req:{payload,user:actor,headers} as never})))throw new Error('Fresh Owner authentication is required.')
  return withPayloadTransaction(payload,async(req:PayloadRequest)=>{req.user=actor as never;req.headers=headers
    const latest=(await payload.find({collection:'published-releases',sort:'-sequence',limit:1,depth:1,overrideAccess:true,req})).docs[0]
    if(!latest||String(latest.id)!==releaseID)throw new Error('Only the current release can be prepared for rollback.')
    const outbox=record(latest.outbox),setID=relationID(outbox.changeSet)
    const set=setID?await payload.findByID({collection:'change-sets',id:setID,depth:0,overrideAccess:true,req}):undefined
    if(!rollbackSupported(set as unknown as Record<string,unknown>|undefined))throw new Error('This release requires a manual reviewed change and cannot be rolled back automatically.')
    const sequence=Number(latest.sequence);const previous=(await payload.find({collection:'published-releases',where:{sequence:{less_than:sequence}},sort:'-sequence',limit:1,depth:1,overrideAccess:true,req})).docs[0]
    const currentSnapshot=record(latest.snapshot),previousSnapshot=record(previous?.snapshot)
    if(!previous||!currentSnapshot.manifest||!previousSnapshot.manifest)throw new Error('An earlier immutable release is required for rollback.')
    return importReviewedSnapshot({payload,req,actor,name:`Rollback release #${sequence}`,manifest:previousSnapshot.manifest,baseline:currentSnapshot.manifest})
  })
}
