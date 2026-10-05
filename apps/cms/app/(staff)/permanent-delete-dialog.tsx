'use client'

import { useEffect, useId, useRef, useState } from 'react'
import styles from './permanent-delete-dialog.module.css'

/** Native modal behavior keeps keyboard focus inside the confirmation. */
export function PermanentDeleteDialog({ kind, identity, busy, onConfirm, onCancel }: {
  kind: 'inquiry' | 'application'; identity: string; busy: boolean;
  onConfirm: () => Promise<void>; onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  const [error, setError] = useState('')
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close() }, [])
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={heading} onCancel={event => { event.preventDefault(); if (!busy) onCancel() }}>
    <h2 id={heading}>Confirm permanent {kind} deletion</h2>
    <p>Permanently delete {identity}?</p>
    <p>This removes the record, its correspondence{kind === 'application' ? ', and its resume' : ''}. This cannot be undone.</p>
    {error && <p role="alert">{error}</p>}
    <div className={styles.actions}>
      <button type="button" autoFocus disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="button" className={styles.danger} disabled={busy} onClick={async () => { setError(''); try { await onConfirm() } catch (failure) { setError(failure instanceof Error ? failure.message : 'Deletion failed. Try again.') } }}>{busy ? 'Deleting…' : 'Confirm permanent deletion'}</button>
    </div>
  </dialog>
}
