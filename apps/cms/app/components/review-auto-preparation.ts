'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type AutomaticReview = {
  id: string
  state: string
  revision: number
  changeKeys: string[]
  preview?: { status?: string; jobID?: string; includedChangeKeys?: string[] }
  ready?: boolean
  blocked?: boolean
}

type Options = {
  review: AutomaticReview | undefined
  selectedKeys: string[]
  refresh: () => Promise<void>
}

const sameKeys = (left: string[], right: string[]) => left.length === right.length && [...left].sort().every((key, index) => key === [...right].sort()[index])

/**
 * Coordinates the browser convenience path only. The server still creates and
 * validates every immutable review proof. One exact revision/selection is
 * attempted once; failures deliberately wait for an explicit retry.
 */
export function useAutomaticReviewPreparation({ review, selectedKeys, refresh }: Options) {
  const attempted = useRef('')
  const currentKey = useRef('')
  const [error, setError] = useState<string>()
  const [preparing, setPreparing] = useState(false)
  // The selection state initializes after the selected review is rendered.
  // Use its captured keys during that single render so opening a submitted
  // review cannot miss the automatic preparation trigger.
  const effectiveKeys = selectedKeys.length ? selectedKeys : review?.changeKeys ?? []
  const selectionMatchesPreview = Boolean(review?.preview?.includedChangeKeys && sameKeys(effectiveKeys, review.preview.includedChangeKeys))
  const key = review ? `${review.id}:${review.revision}:${[...effectiveKeys].sort().join(',')}` : ''

  useEffect(() => { currentKey.current = key; setError(undefined); setPreparing(false) }, [key])

  const prepare = useCallback(async (retry = false) => {
    if (!review || review.state !== 'submitted' || !effectiveKeys.length || (review.blocked && !retry)) return
    if (!retry && attempted.current === key) return
    attempted.current = key
    setPreparing(true); setError(undefined)
    try {
      const response = await fetch('/api/editorial/prepare-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: review.id, includedChangeKeys: effectiveKeys }) })
      const body = await response.json() as { error?: string }
      if (!response.ok) {
        if (currentKey.current === key) setError(body.error ?? 'The protected comparison could not be prepared.')
        return
      }
      await refresh()
    } catch {
      if (currentKey.current === key) setError('The protected comparison could not be prepared. Retry when the service is available.')
    } finally { setPreparing(false) }
  }, [effectiveKeys, key, refresh, review])

  useEffect(() => { void prepare() }, [prepare])
  useEffect(() => {
    if (!review || review.state !== 'submitted' || review.ready || review.blocked || !review.preview?.jobID || !selectionMatchesPreview) return
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => window.clearInterval(timer)
  }, [refresh, review, selectionMatchesPreview])
  useEffect(() => {
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return { preparing, error, retry: () => prepare(true), selectionMatchesPreview }
}
