'use client'

import { useEffect, useState } from 'react'
import { ThemeChooser } from '../themes/theme-chooser'
import { SiteDetailsForm } from './site-details-form'
import { SiteNavigationEditor } from './site-navigation-editor'
import { SiteRedirects } from './site-redirects'
import { SiteSearchAI } from './site-search-ai'
import type { Guide, Redirect, References, Settings } from './site-types'
import styles from './site-workspace.module.css'

type SetSummary = { id: string; name: string; state: string; revision: number; contractVersion: string | null }
type Data = { settings: Settings; settingsHash: string; guide: Guide; guideHash: string; changeSets: SetSummary[]; redirects: Redirect[]; navigation: Array<{ id: string; name: string; pages: Array<{ id: string; title: string; path: string | null; depth: number }> }>; references: References }
type Tab = 'details' | 'navigation' | 'theme' | 'redirects' | 'search'
const tabs: Array<{ id: Tab; label: string }> = [{ id: 'details', label: 'Business details' }, { id: 'navigation', label: 'Navigation' }, { id: 'theme', label: 'Theme' }, { id: 'redirects', label: 'Redirects' }, { id: 'search', label: 'Search and AI' }]

export function SiteWorkspace() {
  const [data, setData] = useState<Data | null>(null)
  const [tab, setTab] = useState<Tab>('details')
  const [selectedSet, setSelectedSet] = useState('')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [guide, setGuide] = useState<Guide | null>(null)
  const [setName, setSetName] = useState('Update site settings')
  const [message, setMessage] = useState('Loading Site…')
  const [busy, setBusy] = useState(false)

  function apply(next: Data) {
    setData(next); setSettings(next.settings); setGuide(next.guide)
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
  async function save(action: 'settings' | 'guide' | 'redirect', value: unknown, extra: Record<string, unknown> = {}): Promise<boolean> {
    const set = data?.changeSets.find(item => item.id === selectedSet)
    if (!set) { setMessage('Choose or create an owned change set first.'); return false }
    setBusy(true)
    try {
      const expectedHash = action === 'settings' ? data!.settingsHash : action === 'guide' ? data!.guideHash : extra.expectedHash
      const response = await fetch('/api/site-workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, value, changeSetID: set.id, expectedRevision: set.revision, expectedHash, ...extra }) })
      const body = await response.json(); if (!response.ok) throw new Error(body.error)
      apply(body)
      setMessage('Saved to the selected draft change set. Public content is unchanged until review and publication.')
      return true
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Site update failed.'); return false } finally { setBusy(false) }
  }
  async function saveSearch(nextGuide: Guide) {
    const set = data?.changeSets.find(item => item.id === selectedSet)
    if (!set || !settings) { setMessage('Choose or create an owned change set first.'); return }
    setBusy(true)
    try {
      const response = await fetch('/api/site-workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        action: 'search-ai', changeSetID: set.id, expectedRevision: set.revision, expectedSettingsHash: data!.settingsHash, expectedGuideHash: data!.guideHash,
        value: { settings: { seoDescription: settings.seoDescription, searchEnabled: settings.searchEnabled, crawlerPolicy: settings.crawlerPolicy ?? { searchEngines: true, aiSearchAndAnswers: true, aiModelTraining: true } }, guide: nextGuide },
      }) })
      const body = await response.json(); if (!response.ok) throw new Error(body.error)
      apply(body); setMessage('Saved to the selected draft change set. Public content is unchanged until review and publication.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Search and AI settings failed.') } finally { setBusy(false) }
  }

  const draftControls = data && tab !== 'theme' ? <section className={styles.changeSet} aria-label="Draft destination"><label htmlFor="site-change-set">Save changes to</label><select id="site-change-set" value={selectedSet} onChange={event => setSelectedSet(event.target.value)}><option value="">Choose a change set</option>{data.changeSets.map(item => <option key={item.id} value={item.id}>{item.name} · {item.state}</option>)}</select><span>or</span><label className={styles.srOnly} htmlFor="site-new-set">New change set name</label><input id="site-new-set" value={setName} onChange={event => setSetName(event.target.value)} maxLength={120} /><button type="button" onClick={() => void createSet()} disabled={busy || !setName.trim()}>Create change set</button><a className={styles.reviewLink} data-site-primary-action href="/editorial">Open Editorial review</a></section> : null

  return <main className={styles.workspace} data-site-workspace>
    <h1 className={styles.srOnly}>Site</h1>
    <nav className={styles.tabs} aria-label="Site settings" data-site-tabs>{tabs.map(item => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} onClick={() => chooseTab(item.id)}>{item.label}</button>)}</nav>
    <p role={message.toLowerCase().includes('failed') || message.toLowerCase().includes('unable') ? 'alert' : 'status'} aria-live="polite" className={styles.message}>{message}</p>
    {data && <>
      {tab === 'details' && settings ? <SiteDetailsForm footer={draftControls} busy={busy} canSave={Boolean(selectedSet)} references={data.references} settings={settings} setSettings={setSettings} onSubmit={event => { event.preventDefault(); void save('settings', settings) }} /> : null}
      {tab === 'navigation' && settings ? <><SiteNavigationEditor busy={busy} canSave={Boolean(selectedSet)} contractVersion={data.changeSets.find(item => item.id === selectedSet)?.contractVersion ?? null} references={data.references} settings={settings} setSettings={setSettings} save={() => void save('settings', settings)} /><details className={styles.structure}><summary>Current content structure</summary>{data.navigation.map(section => <section key={section.id}><h4>{section.name}</h4>{section.pages.length ? <ul>{section.pages.map(page => <li key={page.id} style={{ paddingLeft: `${page.depth}rem` }}><a href={`/content-editor/${page.id}`}>{page.title}</a><span>{page.path ?? 'Route unavailable'}</span></li>)}</ul> : <p>No active pages in this section.</p>}</section>)}<a className={styles.primaryLink} data-site-primary-action href="/content-tree">Edit pages and structure in Content</a></details></> : null}
      {tab === 'theme' ? <section className={styles.panel} data-site-panel="theme"><ThemeChooser embedded /></section> : null}
      {tab === 'redirects' ? <SiteRedirects redirects={data.redirects} busy={busy} canSave={Boolean(selectedSet)} onSave={(value, extra) => save('redirect', value, extra)} /> : null}
      {tab === 'search' && guide && settings ? <SiteSearchAI settings={settings} guide={guide} busy={busy} canSave={Boolean(selectedSet)} contractVersion={data.changeSets.find(item => item.id === selectedSet)?.contractVersion ?? null} revisionKey={data.guideHash} setSettings={setSettings} setGuide={setGuide} save={next => void saveSearch(next)} /> : null}
      {tab !== 'details' ? draftControls : null}
    </>}
  </main>
}
