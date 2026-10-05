'use client'

import { useEffect, useState } from 'react'
import { ThemeChooser } from '../themes/theme-chooser'
import { SiteDetailsForm } from './site-details-form'
import { SiteNavigationEditor } from './site-navigation-editor'
import type { References, Settings } from './site-types'
import styles from './site-workspace.module.css'

type SetSummary = { id: string; name: string; state: string; revision: number }
type Guide = { bannedPhrases: string[]; preferredTerms: string[]; canadianSpelling: 'off' | 'warn'; maximumSentenceWords: number; minimumReadingEase: number }
type Redirect = { id: string; from: string; to: string; hitCount: number; lastHitAt: string | null; hash: string }
type Data = { settings: Settings; settingsHash: string; guide: Guide; guideHash: string; changeSets: SetSummary[]; redirects: Redirect[]; navigation: Array<{ id: string; name: string; pages: Array<{ id: string; title: string; path: string | null; depth: number }> }>; references: References }
type Tab = 'details' | 'navigation' | 'theme' | 'redirects' | 'search'
const tabs: Array<{ id: Tab; label: string }> = [{ id: 'details', label: 'Business details' }, { id: 'navigation', label: 'Navigation' }, { id: 'theme', label: 'Theme' }, { id: 'redirects', label: 'Redirects' }, { id: 'search', label: 'Search and AI' }]
const splitLines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean)

export function SiteWorkspace() {
  const [data, setData] = useState<Data | null>(null)
  const [tab, setTab] = useState<Tab>('details')
  const [selectedSet, setSelectedSet] = useState('')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [guide, setGuide] = useState<Guide | null>(null)
  const [bannedText, setBannedText] = useState('')
  const [preferredText, setPreferredText] = useState('')
  const [redirectDraft, setRedirectDraft] = useState({ id: '', from: '', to: '', hash: '' })
  const [setName, setSetName] = useState('Update site settings')
  const [message, setMessage] = useState('Loading Site…')
  const [busy, setBusy] = useState(false)

  function apply(next: Data) {
    setData(next); setSettings(next.settings); setGuide(next.guide); setBannedText(next.guide.bannedPhrases.join('\n')); setPreferredText(next.guide.preferredTerms.join('\n'))
    setSelectedSet(current => next.changeSets.some(item => item.id === current) ? current : next.changeSets[0]?.id ?? '')
  }
  async function load() {
    try { const response = await fetch('/api/site-workspace', { cache: 'no-store' }); const body = await response.json(); if (!response.ok) throw new Error(body.error); apply(body); setMessage('') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Site could not be loaded.') }
  }
  useEffect(() => {
    const current = new URLSearchParams(window.location.search).get('tab') as Tab | null
    if (current && tabs.some(item => item.id === current)) setTab(current)
    void load()
  }, [])
  function chooseTab(next: Tab) { setTab(next); window.history.replaceState(null, '', `/site?tab=${next}`) }
  async function createSet() {
    setBusy(true)
    try {
      const response = await fetch('/api/editorial/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: setName }) })
      const body = await response.json(); if (!response.ok) throw new Error(body.error)
      await load(); setSelectedSet(body.id); setMessage(`Change set “${body.name ?? setName}” is ready.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to create a change set.') } finally { setBusy(false) }
  }
  async function save(action: 'settings' | 'guide' | 'redirect', value: unknown, extra: Record<string, unknown> = {}) {
    const set = data?.changeSets.find(item => item.id === selectedSet)
    if (!set) { setMessage('Choose or create an owned change set first.'); return }
    setBusy(true)
    try {
      const expectedHash = action === 'settings' ? data!.settingsHash : action === 'guide' ? data!.guideHash : redirectDraft.hash || undefined
      const response = await fetch('/api/site-workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, value, changeSetID: set.id, expectedRevision: set.revision, expectedHash, ...extra }) })
      const body = await response.json(); if (!response.ok) throw new Error(body.error)
      apply(body); if (action === 'redirect') setRedirectDraft({ id: '', from: '', to: '', hash: '' })
      setMessage('Saved to the selected draft change set. Public content is unchanged until review and publication.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Site update failed.') } finally { setBusy(false) }
  }

  const draftControls = data && tab !== 'theme' ? <section className={styles.changeSet} aria-label="Draft destination"><label htmlFor="site-change-set">Save changes to</label><select id="site-change-set" value={selectedSet} onChange={event => setSelectedSet(event.target.value)}><option value="">Choose a change set</option>{data.changeSets.map(item => <option key={item.id} value={item.id}>{item.name} · {item.state}</option>)}</select><span>or</span><label className={styles.srOnly} htmlFor="site-new-set">New change set name</label><input id="site-new-set" value={setName} onChange={event => setSetName(event.target.value)} maxLength={120} /><button type="button" onClick={() => void createSet()} disabled={busy || !setName.trim()}>Create change set</button><a className={styles.reviewLink} data-site-primary-action href="/editorial">Open Editorial review</a></section> : null

  return <main className={styles.workspace} data-site-workspace>
    <h1 className={styles.srOnly}>Site</h1>
    <nav className={styles.tabs} aria-label="Site settings" data-site-tabs>{tabs.map(item => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} onClick={() => chooseTab(item.id)}>{item.label}</button>)}</nav>
    <p role={message.toLowerCase().includes('failed') || message.toLowerCase().includes('unable') ? 'alert' : 'status'} aria-live="polite" className={styles.message}>{message}</p>
    {data && <>
      {tab === 'details' && settings ? <SiteDetailsForm footer={draftControls} busy={busy} canSave={Boolean(selectedSet)} references={data.references} settings={settings} setSettings={setSettings} onSubmit={event => { event.preventDefault(); void save('settings', settings) }} /> : null}
      {tab === 'navigation' && settings ? <><SiteNavigationEditor busy={busy} canSave={Boolean(selectedSet)} references={data.references} settings={settings} setSettings={setSettings} save={() => void save('settings', settings)} /><details className={styles.structure}><summary>Current content structure</summary>{data.navigation.map(section => <section key={section.id}><h4>{section.name}</h4>{section.pages.length ? <ul>{section.pages.map(page => <li key={page.id} style={{ paddingLeft: `${page.depth}rem` }}><a href={`/content-editor/${page.id}`}>{page.title}</a><span>{page.path ?? 'Route unavailable'}</span></li>)}</ul> : <p>No active pages in this section.</p>}</section>)}<a className={styles.primaryLink} data-site-primary-action href="/content-tree">Edit pages and structure in Content</a></details></> : null}
      {tab === 'theme' ? <section className={styles.panel} data-site-panel="theme"><ThemeChooser embedded /></section> : null}
      {tab === 'redirects' ? <section className={styles.panel} data-site-panel="redirects"><header><h2>Redirects</h2><p>Send an old public path to its current destination through the reviewed release.</p></header><form onSubmit={event => { event.preventDefault(); void save('redirect', { from: redirectDraft.from, to: redirectDraft.to }, redirectDraft.id ? { id: redirectDraft.id } : {}) }}><fieldset disabled={busy}><label>Old address<input required pattern="/.*" value={redirectDraft.from} onChange={event => setRedirectDraft({ ...redirectDraft, from: event.target.value })} placeholder="/old-page" /></label><label>Goes to<input required pattern="/.*" value={redirectDraft.to} onChange={event => setRedirectDraft({ ...redirectDraft, to: event.target.value })} placeholder="/new-page" /></label><button disabled={!selectedSet}>{redirectDraft.id ? 'Save redirect' : 'Add redirect'}</button>{redirectDraft.id ? <button type="button" onClick={() => setRedirectDraft({ id: '', from: '', to: '', hash: '' })}>Cancel editing</button> : null}</fieldset></form><div className={styles.tableWrap} tabIndex={0}><table><caption>Current redirects</caption><thead><tr><th>Old address</th><th>Goes to</th><th>Hits</th><th>Last used</th><th><span className={styles.srOnly}>Actions</span></th></tr></thead><tbody>{data.redirects.map(item => <tr key={item.id}><td>{item.from}</td><td>{item.to}</td><td>{item.hitCount}</td><td>{item.lastHitAt ? new Date(item.lastHitAt).toLocaleDateString('en-CA') : 'Not recorded'}</td><td><button type="button" onClick={() => setRedirectDraft({ id: item.id, from: item.from, to: item.to, hash: item.hash })}>Edit</button></td></tr>)}</tbody></table></div></section> : null}
      {tab === 'search' && guide ? <section className={styles.panel} data-site-panel="search"><header><h2>Search and AI</h2><p>Control public site search and the writing guidance used in editorial checks.</p></header><form onSubmit={event => { event.preventDefault(); if (settings) void save('settings', { ...data.settings, searchEnabled: settings.searchEnabled }) }}><fieldset disabled={busy}><legend>Site search</legend><label className={styles.check}><input type="checkbox" checked={settings?.searchEnabled ?? false} onChange={event => settings && setSettings({ ...settings, searchEnabled: event.target.checked })} />Include public search after this change is reviewed and published</label><button disabled={!selectedSet || !settings}>Save search setting</button></fieldset></form><form onSubmit={event => { event.preventDefault(); void save('guide', { ...guide, bannedPhrases: splitLines(bannedText), preferredTerms: splitLines(preferredText) }) }}><fieldset disabled={busy}><legend>Writing guidance</legend><label>Words or phrases to avoid<textarea value={bannedText} onChange={event => setBannedText(event.target.value)} /></label><label>Preferred terms<textarea value={preferredText} onChange={event => setPreferredText(event.target.value)} /></label><div className={styles.grid}><label>Canadian spelling<select value={guide.canadianSpelling} onChange={event => setGuide({ ...guide, canadianSpelling: event.target.value as Guide['canadianSpelling'] })}><option value="off">Off</option><option value="warn">Warn</option></select></label><label>Maximum words per sentence<input type="number" min={5} max={100} value={guide.maximumSentenceWords} onChange={event => setGuide({ ...guide, maximumSentenceWords: Number(event.target.value) })} /></label><label>Minimum reading ease<input type="number" min={0} max={121} value={guide.minimumReadingEase} onChange={event => setGuide({ ...guide, minimumReadingEase: Number(event.target.value) })} /></label></div><button disabled={!selectedSet}>Save writing guidance</button></fieldset></form><aside className={styles.note}><h3>Crawler access</h3><p>Robots and AI crawler policy is controlled by the deployed site configuration. This workspace does not yet store a reviewed crawler policy.</p></aside></section> : null}
      {tab !== 'details' ? draftControls : null}
    </>}
  </main>
}
