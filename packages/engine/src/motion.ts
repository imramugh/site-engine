export type MotionPreference = 'reduce' | 'allow'
export const motionPreferenceKey = 'site-engine:motion'
export function effectiveMotion(stored: MotionPreference | null, systemReduced: boolean) { return stored === 'reduce' || (stored === null && systemReduced) ? 'reduce' : 'allow' }
export function resolveMotionPreset(intent: string, preset: string | undefined, supported: ReadonlySet<string>) { return preset && supported.has(preset) ? preset : intent }
export function mountMotionRuntime(document: Document, window: Window) {
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)'); let choice: MotionPreference | null
  try { const v=window.localStorage.getItem(motionPreferenceKey); choice=v==='reduce'||v==='allow'?v:null } catch { choice=null }
  const apply=()=>{ const value=effectiveMotion(choice,Boolean(media?.matches)); document.documentElement.dataset.motion=value; for(const node of document.querySelectorAll<HTMLElement>('[data-motion]')) { const still=node.closest('form,[data-urgent-contact]')||value==='reduce'||node.dataset.motionVisible!=='true'; node.dataset.motionPaused=String(Boolean(still)) } for(const control of document.querySelectorAll<HTMLElement>('[data-motion-toggle]')) control.setAttribute('aria-pressed',String(value==='reduce')) }
  const toggle=()=>{choice=document.documentElement.dataset.motion==='reduce'?'allow':'reduce';try{window.localStorage.setItem(motionPreferenceKey,choice)}catch{} apply()}
  const controls=[...document.querySelectorAll<HTMLElement>('[data-motion-toggle]')]; controls.forEach(n=>n.addEventListener('click',toggle)); const Observer=(window as unknown as {IntersectionObserver?:typeof IntersectionObserver}).IntersectionObserver; const observer=Observer?new Observer(entries=>{for(const e of entries)(e.target as HTMLElement).dataset.motionVisible=String(e.isIntersecting);apply()}):undefined
  document.querySelectorAll<HTMLElement>('[data-motion]').forEach(n=>{n.dataset.motionVisible='false';observer?.observe(n)});media?.addEventListener('change',apply);apply();return()=>{controls.forEach(n=>n.removeEventListener('click',toggle));observer?.disconnect();media?.removeEventListener('change',apply)}
}
