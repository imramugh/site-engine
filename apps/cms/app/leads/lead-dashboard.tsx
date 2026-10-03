'use client'

import { useEffect, useState } from 'react'

type Lead = { id: string; email: string; topic: string; message: string; stage: string; urgent?: boolean; sourcePage: string }
const stages = ['new', 'qualified', 'contacted', 'proposal', 'won', 'lost']

export function LeadDashboard() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const load = async (filter = stage) => {
    const response = await fetch(`/api/leads${filter ? `?stage=${encodeURIComponent(filter)}` : ''}`, { cache: 'no-store' })
    if (!response.ok) { setError('You need a Sales or Owner session to view leads.'); return }
    const data = await response.json() as { leads: Lead[] }
    setLeads(data.leads); setError('')
  }
  useEffect(() => { void load('') }, [])
  return <main>
    <h1>Lead pipeline</h1>
    <p><label htmlFor="stage-filter">Filter stage</label> <select id="stage-filter" value={stage} onChange={(event) => { setStage(event.target.value); void load(event.target.value) }}><option value="">All stages</option>{stages.map((item) => <option key={item} value={item}>{item}</option>)}</select> <a href={`/api/leads/export${stage ? `?stage=${encodeURIComponent(stage)}` : ''}`}>Export CSV</a></p>
    {error && <p role="alert">{error}</p>}
    <section aria-label="Urgent leads">{leads.filter((lead) => lead.urgent).map((lead) => <article key={lead.id}><h2>Urgent: {lead.email}</h2><p>{lead.topic} from {lead.sourcePage}</p><p>{lead.message}</p></article>)}</section>
    {stages.map((item) => <section key={item} aria-label={`${item} leads`}><h2>{item}</h2><ul>{leads.filter((lead) => lead.stage === item).map((lead) => <li key={lead.id}><strong>{lead.email}</strong> — {lead.topic}<br />{lead.message}</li>)}</ul></section>)}
  </main>
}
