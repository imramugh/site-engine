'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import styles from './lead-workspace.module.css'
import { PermanentDeleteDialog } from '../permanent-delete-dialog'
import { MailReplyComposer } from '../mail-reply-composer'

type Assignee = { id: string; name: string; email: string }
type Stage = 'new' | 'qualified' | 'contacted' | 'proposal' | 'won' | 'lost'
type Lead = { id: string; email: string; name?: string; telephone?: string; company?: string; topic: string; message: string; stage: Stage; urgent?: boolean; sourcePage: string; notes?: string; nextAction?: string; assignee?: string | null; consentBasis?: string; consentedAt?: string; createdAt?: string; updatedAt?: string }
type PipelineGroup = { leads: Lead[]; totalDocs: number; hasMore: boolean }
type Data = { leads: Lead[]; pipeline: Record<Stage, PipelineGroup>; assignees: Assignee[]; sourcePages: string[]; spamTotalDocs: number; canDeleteSpam: boolean; page: number; totalPages: number; totalDocs: number; hasNextPage: boolean; hasPrevPage: boolean }
type Filters = { stage: string; urgent: boolean; assignee: string; sourcePage: string; received: string; page: number }

const stages: Stage[] = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost']
const stageLabels: Record<Stage, string> = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', proposal: 'Proposal sent', won: 'Won', lost: 'Lost' }
const transitions: Record<Stage, Stage[]> = {
  new: ['new', 'contacted', 'qualified', 'lost'], qualified: ['qualified', 'contacted', 'proposal', 'lost'],
  contacted: ['contacted', 'qualified', 'proposal', 'lost'], proposal: ['proposal', 'won', 'lost', 'contacted'], won: ['won'], lost: ['lost'],
}
const topics = ['general', 'project', 'partnership', 'active-incident', 'consultation', 'service', 'retainer', 'careers']
const blank = { email: '', name: '', topic: 'general', sourcePage: '/manual', message: '', consent: false }
const emptyPipeline = (): Record<Stage, PipelineGroup> => ({ new: { leads: [], totalDocs: 0, hasMore: false }, qualified: { leads: [], totalDocs: 0, hasMore: false }, contacted: { leads: [], totalDocs: 0, hasMore: false }, proposal: { leads: [], totalDocs: 0, hasMore: false }, won: { leads: [], totalDocs: 0, hasMore: false }, lost: { leads: [], totalDocs: 0, hasMore: false } })
const emptyData = (): Data => ({ leads: [], pipeline: emptyPipeline(), assignees: [], sourcePages: [], spamTotalDocs: 0, canDeleteSpam: false, page: 1, totalPages: 1, totalDocs: 0, hasNextPage: false, hasPrevPage: false })

function parameters(filters: Filters, spam = false) {
  const params = new URLSearchParams()
  if (filters.stage) params.set('stage', filters.stage)
  if (filters.urgent) params.set('urgent', 'true')
  if (filters.assignee) params.set('assignee', filters.assignee)
  if (filters.sourcePage) params.set('sourcePage', filters.sourcePage)
  params.set('received', filters.received)
  params.set('page', String(filters.page))
  if (spam) params.set('spam', 'true')
  return params.toString()
}

function displayName(lead: Lead) { return lead.company || lead.name || lead.email }
function formatDate(value?: string) { if (!value) return 'Unknown'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'Unknown' : new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium' }).format(date) }
function age(value?: string) {
  if (!value) return 'Unknown'
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).valueOf()) / 86_400_000))
  if (days === 0) return 'Today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

function LeadCard({ lead, active, onOpen }: { lead: Lead; active: boolean; onOpen: () => void }) {
  return <button type="button" className={styles.card} aria-pressed={active} onClick={onOpen} data-lead-card data-urgent={lead.urgent ? 'true' : undefined}>
    {lead.urgent && <span className={styles.urgent}>Active incident</span>}
    <strong>{displayName(lead)}</strong>
    <span>{lead.name && lead.company ? `${lead.name} · ` : ''}{lead.topic}</span>
    <small><span>{lead.sourcePage}</span><span>{age(lead.createdAt)}</span></small>
    {lead.nextAction && <em>→ {lead.nextAction}</em>}
  </button>
}

function LeadDetail({ lead, assignees, saving, owner, onClose, onSave, onSpam, onPurge }: { lead: Lead; assignees: Assignee[]; saving: boolean; owner: boolean; onClose: () => void; onSave: (update: { stage: Stage; assignee: string | null; notes: string; nextAction: string }) => Promise<void>; onSpam: () => Promise<void>; onPurge: () => Promise<void> }) {
  const [stage, setStage] = useState(lead.stage)
  const [assignee, setAssignee] = useState(lead.assignee ?? '')
  const [notes, setNotes] = useState(lead.notes ?? '')
  const [nextAction, setNextAction] = useState(lead.nextAction ?? '')
  const [confirm, setConfirm] = useState(false)
  return <aside className={styles.detail} aria-label="Lead details" data-lead-detail>
    <header className={styles.detailHeader}>
      <div><h2>{displayName(lead)}</h2><p>{lead.name && lead.company ? lead.name : lead.email}</p></div>
      <button type="button" className={styles.iconButton} aria-label="Close lead details" onClick={onClose}>×</button>
    </header>
    <dl className={styles.facts}>
      <dt>Stage</dt><dd><span className={styles.badge}>{stageLabels[lead.stage]}</span></dd>
      <dt>Email</dt><dd>{lead.email}</dd>
      {lead.telephone && <><dt>Phone</dt><dd>{lead.telephone}</dd></>}
      <dt>Source</dt><dd>{lead.sourcePage}</dd>
      <dt>Received</dt><dd><time dateTime={lead.createdAt}>{formatDate(lead.createdAt)}</time></dd>
      <dt>Consent</dt><dd>{lead.consentBasis ?? 'Unknown'}{lead.consentedAt ? ` · ${formatDate(lead.consentedAt)}` : ''}</dd>
    </dl>
    <section className={styles.message}><h3>Inquiry</h3><p>{lead.message}</p></section>
    <MailReplyComposer key={lead.id} target="lead" id={lead.id} recipient={lead.email} />
    <form className={styles.editForm} onSubmit={(event) => { event.preventDefault(); void onSave({ stage, assignee: assignee || null, notes, nextAction }) }}>
      <label>Stage<select value={stage} onChange={(event) => setStage(event.target.value as Stage)}>{transitions[lead.stage].map((value) => <option key={value} value={value}>{stageLabels[value]}</option>)}</select></label>
      <label>Active assignee<select value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">Unassigned</option>{assignees.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      <label>Notes<textarea rows={4} maxLength={5000} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <label>Next action<textarea rows={3} maxLength={5000} value={nextAction} onChange={(event) => setNextAction(event.target.value)} /></label>
      <button className={styles.primary} disabled={saving}>Save lead details</button>
      <button type="button" className={styles.danger} disabled={saving} onClick={() => void onSpam()}>Mark as spam</button>
      {owner&&<><button type="button" className={styles.danger} onClick={()=>setConfirm(true)}>Permanently delete inquiry</button>{confirm && <PermanentDeleteDialog kind="inquiry" identity={`${displayName(lead)} (${lead.email})`} busy={saving} onConfirm={onPurge} onCancel={() => setConfirm(false)} />}</>}
    </form>
  </aside>
}

export function LeadDashboard({ owner = false }: { owner?: boolean }) {
  const [data, setData] = useState<Data>(emptyData)
  const [mode, setMode] = useState<'pipeline' | 'list' | 'spam'>('pipeline')
  const [filters, setFilters] = useState<Filters>({ stage: '', urgent: false, assignee: '', sourcePage: '', received: '90', page: 1 })
  const [selected, setSelected] = useState<string | null>(null)
  const [manual, setManual] = useState(blank)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const addButton = useRef<HTMLButtonElement>(null)
  const allLeads = useMemo(() => [...data.leads, ...stages.flatMap((stage) => data.pipeline[stage].leads)].filter((lead, index, items) => items.findIndex((item) => item.id === lead.id) === index), [data])
  const active = allLeads.find((lead) => lead.id === selected) ?? null

  async function load(next = filters, keepSelected = true, nextMode = mode) {
    setLoading(true)
    try {
      const response = await fetch(`/api/leads?${parameters(next, nextMode === 'spam')}`, { cache: 'no-store' })
      const body = await response.json() as Data & { error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Leads could not be loaded.')
      setData(body); setError('')
      const available = [...body.leads, ...stages.flatMap((stage) => body.pipeline[stage].leads)]
      setSelected((current) => keepSelected && available.some((lead) => lead.id === current) ? current : null)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Leads could not be loaded.') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load({ stage: '', urgent: false, assignee: '', sourcePage: '', received: '90', page: 1 }, false, 'pipeline') }, [])
  useEffect(() => {
    if (!dialogOpen) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') closeDialog() }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [dialogOpen])

  function changeFilters(change: Partial<Filters>) { const next = { ...filters, ...change, page: change.page ?? 1 }; setFilters(next); void load(next) }
  function changeMode(nextMode: 'pipeline' | 'list' | 'spam') {
    const nextFilters = nextMode === 'spam' ? { ...filters, stage: '', urgent: false, assignee: '', sourcePage: '', page: 1 } : filters
    setMode(nextMode); setFilters(nextFilters); setSelected(null); setMessage(''); setError(''); void load(nextFilters, false, nextMode)
  }
  function closeDialog() { setDialogOpen(false); requestAnimationFrame(() => addButton.current?.focus()) }
  async function createManual(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setMessage(''); setError('')
    try {
      const response = await fetch('/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...manual, consentBasis: 'staff-recorded' }) })
      const body = await response.json() as { errors?: Record<string, string>; error?: string }
      if (!response.ok) { setError(body.error ?? (Object.values(body.errors ?? {}).join(' ') || 'The manual lead could not be created.')); return }
      setManual(blank); closeDialog(); setMessage('Manual lead recorded with staff-recorded consent.'); await load({ ...filters, page: 1 }, false)
    } catch { setError('The manual lead could not be created. Try again.') }
    finally { setSaving(false) }
  }
  async function saveLead(update: { stage: Stage; assignee: string | null; notes: string; nextAction: string }) {
    if (!active) return
    setSaving(true); setMessage(''); setError('')
    try {
      const response = await fetch(`/api/leads/${active.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) })
      const body = await response.json() as { error?: string }
      if (!response.ok) { setError(body.error ?? 'The lead could not be updated.'); return }
      setMessage('Lead details saved.'); await load(filters)
    } catch { setError('The lead could not be updated. Try again.') }
    finally { setSaving(false) }
  }

  async function spamAction(id: string, action: 'mark-spam' | 'not-spam') {
    setSaving(true); setMessage(''); setError('')
    try {
      const response = await fetch(`/api/leads/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
      const body = await response.json() as { error?: string }
      if (!response.ok) { setError(body.error ?? 'The spam classification could not be updated.'); return }
      setSelected(null); setMessage(action === 'mark-spam' ? 'Lead moved to Spam.' : 'Submission moved to New leads.'); await load(filters, false, mode)
    } catch { setError('The spam classification could not be updated. Try again.') }
    finally { setSaving(false) }
  }
  async function deleteSpam(id: string) {
    if (!window.confirm('Permanently delete this spam submission? This cannot be undone.')) return
    setSaving(true); setMessage(''); setError('')
    try {
      const response = await fetch(`/api/leads/${id}`, { method: 'DELETE' })
      if (!response.ok) { const body = await response.json() as { error?: string }; setError(body.error ?? 'The spam submission could not be deleted.'); return }
      setMessage('Spam submission permanently deleted.'); await load(filters, false, 'spam')
    } catch { setError('The spam submission could not be deleted. Try again.') }
    finally { setSaving(false) }
  }
  async function purgeInquiry() {
    if (!active) return
    setSaving(true); setError('')
    try {
      const response = await fetch('/api/retention', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inquiryID: active.id, confirm: 'permanent-delete' }) })
      if (!response.ok) throw new Error('The inquiry could not be deleted. Check your session and try again.')
      setSelected(null); setMessage('Inquiry permanently deleted.'); await load(filters, false, mode)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Deletion failed.') }
    finally { setSaving(false) }
  }

  return <main className={styles.workspace} aria-busy={loading || saving} data-leads-workspace>
    <h1 className={styles.srOnly}>Lead pipeline</h1>
    <div className={styles.actions}>
      <div className={styles.tabs} role="group" aria-label="Lead view">
        <button type="button" aria-pressed={mode === 'pipeline'} onClick={() => changeMode('pipeline')}>Pipeline</button>
        <button type="button" aria-pressed={mode === 'list'} onClick={() => changeMode('list')}>List</button>
        <button type="button" aria-pressed={mode === 'spam'} onClick={() => changeMode('spam')} data-leads-tab="spam">Spam · {data.spamTotalDocs}</button>
      </div>
      <div><a className={styles.button} href={`/api/leads/export?${parameters(filters)}`}>Export CSV</a><button ref={addButton} type="button" className={styles.primary} onClick={() => setDialogOpen(true)}>+ Add lead</button></div>
    </div>
    <p className={styles.status} role="status" aria-live="polite">{message}</p>
    {error && <div className={styles.error} role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>Try again</button></div>}
    <div className={`${styles.layout} ${active ? styles.withDetail : ''}`}>
      <section className={styles.content} aria-label={mode === 'pipeline' ? 'Lead pipeline' : mode === 'list' ? 'Lead list' : 'Spam submissions'} data-leads-view={mode}>
        {mode !== 'spam' && <div className={styles.filters} aria-label="Lead filters" data-lead-filters>
          {mode === 'list' && <label>Stage<select value={filters.stage} onChange={(event) => changeFilters({ stage: event.target.value })}><option value="">All stages</option>{stages.map((stage) => <option key={stage} value={stage}>{stageLabels[stage]}</option>)}</select></label>}
          <label>Source<select value={filters.sourcePage} onChange={(event) => changeFilters({ sourcePage: event.target.value })}><option value="">All sources</option>{data.sourcePages.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>
          <label>Received<select value={filters.received} onChange={(event) => changeFilters({ received: event.target.value })}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last year</option><option value="all">All time</option></select></label>
          <label>Assignee<select value={filters.assignee} onChange={(event) => changeFilters({ assignee: event.target.value })}><option value="">Anyone</option>{data.assignees.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
          <label className={styles.check}><input type="checkbox" checked={filters.urgent} onChange={(event) => changeFilters({ urgent: event.target.checked })} /> Urgent only</label>
        </div>}
        {loading && !allLeads.length ? <p className={styles.empty}>Loading leads…</p> : mode === 'pipeline' ? <div className={styles.pipeline} data-leads-pipeline tabIndex={0} role="region" aria-label="Lead pipeline board" aria-describedby="lead-pipeline-instructions">
          <p id="lead-pipeline-instructions" className={styles.srOnly}>Use the arrow keys to scroll through pipeline stages.</p>
          {stages.map((stage) => <section className={styles.column} key={stage} aria-labelledby={`stage-${stage}`}>
            <header><h2 id={`stage-${stage}`}>{stageLabels[stage]}</h2><span>{data.pipeline[stage].totalDocs}</span></header>
            <div>{data.pipeline[stage].leads.map((lead) => <LeadCard key={lead.id} lead={lead} active={active?.id === lead.id} onOpen={() => setSelected(lead.id)} />)}{!data.pipeline[stage].leads.length && <p>No leads</p>}</div>
            {data.pipeline[stage].hasMore && <small>Showing {data.pipeline[stage].leads.length} of {data.pipeline[stage].totalDocs}</small>}
          </section>)}
        </div> : mode === 'list' ? <>
          <div className={styles.listHeader}><span>Lead</span><span>Topic</span><span>Stage</span><span>Source</span><span>Received</span><span>Next action</span></div>
          <div className={styles.list}>{data.leads.map((lead) => <button type="button" key={lead.id} aria-pressed={active?.id === lead.id} onClick={() => setSelected(lead.id)}>
            <span><strong>{displayName(lead)}</strong><small>{lead.email}</small></span><span>{lead.topic}</span><span><em className={styles.badge}>{stageLabels[lead.stage]}</em></span><span>{lead.sourcePage}</span><span>{age(lead.createdAt)}</span><span>{lead.nextAction || '—'}</span>
          </button>)}</div>
          {!data.leads.length && <p className={styles.empty}>No leads match these filters.</p>}
          <div className={styles.pagination}><button disabled={!data.hasPrevPage} onClick={() => changeFilters({ page: data.page - 1 })}>Previous</button><span>Page {data.page} of {data.totalPages} · {data.totalDocs} lead{data.totalDocs === 1 ? '' : 's'}</span><button disabled={!data.hasNextPage} onClick={() => changeFilters({ page: data.page + 1 })}>Next</button></div>
        </> : <section className={styles.spam} data-leads-spam>
          <p>Submissions classified as spam do not appear in the pipeline, exports, or alert queue. An Owner can permanently delete them.</p>
          <div className={styles.spamHeader}><span>From</span><span>Message</span><span>Received</span><span>Actions</span></div>
          {data.leads.map((lead) => <div className={styles.spamRow} key={lead.id} data-spam-row>
            <span><strong>{lead.name || lead.company || lead.email}</strong><small>{lead.email}</small></span><span>{lead.message}</span><time dateTime={lead.createdAt}>{formatDate(lead.createdAt)}</time><span><button type="button" disabled={saving} onClick={() => void spamAction(lead.id, 'not-spam')}>Not spam</button>{data.canDeleteSpam && <button type="button" className={styles.danger} disabled={saving} onClick={() => void deleteSpam(lead.id)}>Delete</button>}</span>
          </div>)}
          {!data.leads.length && <p className={styles.empty}>No spam.</p>}
        </section>}
      </section>
      {active && mode !== 'spam' && <LeadDetail key={active.id} lead={active} assignees={data.assignees} saving={saving} owner={owner} onClose={() => setSelected(null)} onSave={saveLead} onSpam={() => spamAction(active.id, 'mark-spam')} onPurge={purgeInquiry} />}
    </div>
    {dialogOpen && <div className={styles.dialogBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog() }}>
      <section role="dialog" aria-modal="true" aria-labelledby="add-lead-title" className={styles.dialog}>
        <header><h2 id="add-lead-title">Add lead</h2><button type="button" aria-label="Close add lead" className={styles.iconButton} onClick={closeDialog}>×</button></header>
        <form onSubmit={createManual}>
          <div className={styles.formGrid}><label>Email<input autoFocus required type="email" value={manual.email} onChange={(event) => setManual({ ...manual, email: event.target.value })} /></label><label>Name<input value={manual.name} onChange={(event) => setManual({ ...manual, name: event.target.value })} /></label></div>
          <div className={styles.formGrid}><label>Topic<select value={manual.topic} onChange={(event) => setManual({ ...manual, topic: event.target.value })}>{topics.map((topic) => <option key={topic}>{topic}</option>)}</select></label><label>Source page<input required value={manual.sourcePage} onChange={(event) => setManual({ ...manual, sourcePage: event.target.value })} /></label></div>
          <label>Message<textarea rows={5} required maxLength={5000} value={manual.message} onChange={(event) => setManual({ ...manual, message: event.target.value })} /></label>
          <label className={styles.consent}><input required type="checkbox" checked={manual.consent} onChange={(event) => setManual({ ...manual, consent: event.target.checked })} /> I recorded the contact&apos;s consent for staff follow-up.</label>
          <footer><button type="button" onClick={closeDialog}>Cancel</button><button className={styles.primary} disabled={saving}>Create manual lead</button></footer>
        </form>
      </section>
    </div>}
  </main>
}
