'use client'

import { useEffect, useState } from 'react'
import type { Guide, Settings } from './site-types'
import styles from './site-workspace.module.css'

const defaultPolicy = { searchEngines: true, aiSearchAndAnswers: true, aiModelTraining: true }
const phrases = (value: string) => [...new Set(value.split(/[,\n]/).map(item => item.trim()).filter(Boolean))]
const preferred = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
  const parts = line.split(/\s*(?:=>|→)\s*/)
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Write each preferred term as “avoid → prefer”, one per line.')
  return { avoid: parts[0], prefer: parts[1] }
})

type Props = {
  settings: Settings
  guide: Guide
  busy: boolean
  canSave: boolean
  contractVersion: string | null
  revisionKey: string
  setSettings: (value: Settings) => void
  setGuide: (value: Guide) => void
  save: (guide: Guide) => void
}

export function SiteSearchAI({ settings, guide, busy, canSave, contractVersion, revisionKey, setSettings, setGuide, save }: Props) {
  const [bannedText, setBannedText] = useState(guide.bannedPhrases.join(', '))
  const [preferredText, setPreferredText] = useState(guide.preferredTerms.map(term => `${term.avoid} → ${term.prefer}`).join('\n'))
  const [error, setError] = useState('')
  useEffect(() => {
    setBannedText(guide.bannedPhrases.join(', '))
    setPreferredText(guide.preferredTerms.map(term => `${term.avoid} → ${term.prefer}`).join('\n'))
  }, [revisionKey])
  const policy = settings.crawlerPolicy ?? defaultPolicy
  const updatePolicy = (field: keyof typeof defaultPolicy, checked: boolean) => setSettings({ ...settings, crawlerPolicy: { ...policy, [field]: checked } })
  const supported = contractVersion === '1.7.0'

  return <section className={styles.searchWorkspace} data-site-panel="search" data-site-search-ai>
    <form onSubmit={event => {
      event.preventDefault()
      try {
        const next = { ...guide, bannedPhrases: phrases(bannedText), preferredTerms: preferred(preferredText) }
        setGuide(next); setError(''); save(next)
      } catch (caught) { setError(caught instanceof Error ? caught.message : 'Check the writing guidance.') }
    }}>
      <fieldset disabled={busy}>
        <legend className={styles.srOnly}>Search and AI settings</legend>
        <div className={styles.searchCards}>
          <section className={styles.searchCard} data-site-search-card="crawlers">
            <header><h2>Crawler access</h2></header>
            <label className={styles.crawlerControl} data-site-crawler-control="search">
              <span><strong>Search engines</strong><small>Google, Bing</small></span>
              <input type="checkbox" checked={policy.searchEngines} onChange={event => updatePolicy('searchEngines', event.target.checked)} />
            </label>
            <label className={styles.crawlerControl} data-site-crawler-control="answers">
              <span><strong>AI search and answers</strong><small>ChatGPT search, Claude, Perplexity</small></span>
              <input type="checkbox" checked={policy.aiSearchAndAnswers} onChange={event => updatePolicy('aiSearchAndAnswers', event.target.checked)} />
            </label>
            <label className={styles.crawlerControl} data-site-crawler-control="training">
              <span><strong>AI model training</strong><small>GPTBot, ClaudeBot, Google-Extended</small></span>
              <input type="checkbox" checked={policy.aiModelTraining} onChange={event => updatePolicy('aiModelTraining', event.target.checked)} />
            </label>
          </section>

          <section className={styles.searchCard} data-site-search-card="description-style">
            <header><h2>Site description and style</h2></header>
            <label><span className={styles.fieldLabel}><strong>Short description</strong><small aria-hidden="true">used for llms.txt and profiles</small></span><textarea maxLength={160} value={settings.seoDescription ?? ''} onChange={event => setSettings({ ...settings, seoDescription: event.target.value || null })} /></label>
            <label><span className={styles.fieldLabel}><strong>Words to avoid</strong><small aria-hidden="true">style warnings</small></span><input value={bannedText} onChange={event => setBannedText(event.target.value)} placeholder="Enter words or phrases, separated by commas" /></label>
            <label>Spelling<select value={guide.canadianSpelling} onChange={event => setGuide({ ...guide, canadianSpelling: event.target.value as Guide['canadianSpelling'] })}><option value="warn">Canadian English (en-CA)</option><option value="off">No spelling preference</option></select></label>
          </section>
        </div>

        <details className={styles.searchAdditional} data-site-search-additional>
          <summary>Additional search and writing checks</summary>
          <div className={styles.searchAdditionalGrid}>
            <p className={styles.crawlerNote}>Robots.txt is a request to supported crawlers, not access enforcement. User-requested visits from some AI services may not follow it.</p>
            <label className={styles.check}><input type="checkbox" checked={settings.searchEnabled} onChange={event => setSettings({ ...settings, searchEnabled: event.target.checked })} />Include the public site search page after review and publication</label>
            <label>Preferred terms<textarea value={preferredText} onChange={event => setPreferredText(event.target.value)} placeholder={'utilize → use\ncenter → centre'} /><small>One “avoid → prefer” pair per line</small></label>
            <label>Maximum words per sentence<input type="number" min={5} max={100} value={guide.maximumSentenceWords} onChange={event => setGuide({ ...guide, maximumSentenceWords: Number(event.target.value) })} /></label>
            <label>Minimum reading ease<input type="number" min={0} max={121} value={guide.minimumReadingEase} onChange={event => setGuide({ ...guide, minimumReadingEase: Number(event.target.value) })} /></label>
          </div>
        </details>
        {error ? <p className={styles.searchError} role="alert">{error}</p> : null}
        {!supported ? <p className={styles.searchCapability}>Select a contract 1.7 theme in this change set to save crawler preferences.</p> : null}
        <button type="submit" disabled={!canSave || !supported}>Save Search and AI</button>
      </fieldset>
    </form>
  </section>
}
