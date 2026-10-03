export type MotionPreference = 'reduce' | 'allow'
export const motionPreferenceKey = 'site-engine:motion'
export function effectiveMotion(stored: MotionPreference | null, systemReduced: boolean) { return stored === 'reduce' || (stored === null && systemReduced) ? 'reduce' : 'allow' }
export function mountMotionRuntime(document: Document, window: Window) {
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  const read = (): MotionPreference | null => { try { const value = window.localStorage.getItem(motionPreferenceKey); return value === 'reduce' || value === 'allow' ? value : null } catch { return null } }
  const apply = () => { const value = effectiveMotion(read(), Boolean(media?.matches)); document.documentElement.dataset.motion = value; for (const node of document.querySelectorAll<HTMLElement>('[data-motion]')) node.dataset.motionPaused = value === 'reduce' || node.dataset.motionVisible === 'false' ? 'true' : 'false' }
  const toggle = () => { const next: MotionPreference = document.documentElement.dataset.motion === 'reduce' ? 'allow' : 'reduce'; try { window.localStorage.setItem(motionPreferenceKey, next) } catch {} apply() }
  const controls = [...document.querySelectorAll<HTMLElement>('[data-motion-toggle]')]; controls.forEach((node) => node.addEventListener('click', toggle))
  const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver((entries) => { for (const entry of entries) (entry.target as HTMLElement).dataset.motionVisible = String(entry.isIntersecting); apply() })
  document.querySelectorAll<HTMLElement>('[data-motion]').forEach((node) => observer?.observe(node)); media?.addEventListener('change', apply); apply()
  return () => { controls.forEach((node) => node.removeEventListener('click', toggle)); observer?.disconnect(); media?.removeEventListener('change', apply) }
}
