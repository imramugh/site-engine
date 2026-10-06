/** A visitor's explicit choice, if one has been saved. */
export type MotionPreference = 'reduce' | 'allow';

/** The effective setting applied to the document. */
export type EffectiveMotion = MotionPreference;

/** A theme effect name that can be rendered, or undefined for a still frame. */
export type ResolvedMotionPreset = string | undefined;

export const motionPreferenceKey = 'site-engine:motion';

/**
 * An explicit visitor choice takes precedence over the operating-system setting.
 * The OS setting is used only until the visitor makes a choice.
 */
export function effectiveMotion(
  stored: MotionPreference | null,
  systemReduced: boolean,
): EffectiveMotion {
  return stored === 'reduce' || (stored === null && systemReduced) ? 'reduce' : 'allow';
}

/**
 * Use the selected theme preset when it exists. If a theme switch removed that
 * preset, the content's declared intent may act as a preset only when the new
 * theme supports it. An unsupported intent renders as a still frame.
 */
export function resolveMotionPreset(
  intent: string,
  preset: string | undefined,
  supportedPresets: ReadonlySet<string>,
  intentFallbacks?: ReadonlyMap<string, string>,
): ResolvedMotionPreset {
  if (intent === 'none') return undefined;
  if (preset && supportedPresets.has(preset)) return preset;
  const fallback = intentFallbacks?.get(intent) ?? intent;
  return supportedPresets.has(fallback) ? fallback : undefined;
}

/**
 * Resolve a preset while switching themes.  Unlike the legacy convenience
 * resolver, portability only uses a fallback explicitly declared by the
 * target theme: matching intent and preset names are not evidence that a
 * foreign preset is safe to hand to a renderer.
 */
export function resolveDeclaredMotionPreset(
  intent: string,
  preset: string | undefined,
  supportedPresets: ReadonlySet<string>,
  intentFallbacks?: ReadonlyMap<string, string>,
): ResolvedMotionPreset {
  if (intent === 'none') return undefined;
  if (preset && supportedPresets.has(preset)) return preset;
  const fallback = intentFallbacks?.get(intent);
  return fallback && supportedPresets.has(fallback) ? fallback : undefined;
}

type MotionMediaQuery = MediaQueryList & {
  addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
};

type MotionWindow = Window & {
  IntersectionObserver?: typeof IntersectionObserver;
};

function savedMotionPreference(window: Window): MotionPreference | null {
  try {
    const value = window.localStorage.getItem(motionPreferenceKey);
    return value === 'reduce' || value === 'allow' ? value : null;
  } catch {
    return null;
  }
}

function videosFor(effect: HTMLElement): HTMLVideoElement[] {
  const videos = [...effect.querySelectorAll<HTMLVideoElement>('video')];
  return effect instanceof HTMLVideoElement ? [effect, ...videos] : videos;
}

function setEffectStill(effect: HTMLElement, still: boolean): void {
  effect.dataset.motionPaused = String(still);
  if (still) {
    // This runtime never calls play(): only native controls or an author-defined
    // interaction may start playback, preserving the visitor's browser choice.
    for (const video of videosFor(effect)) video.pause();
  }
}

/**
 * Mount the progressive-enhancement runtime for elements marked with
 * data-motion-effect. CSS must start each effect paused so the no-JS path is a
 * readable still. Video effects must declare a poster; the runtime pauses them
 * while reduced, off-screen, in a form, or in an urgent-contact region.
 */
export function mountMotionRuntime(document: Document, window: Window): () => void {
  const motionWindow = window as MotionWindow;
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)') as MotionMediaQuery | undefined;
  let choice = savedMotionPreference(window);
  const effects = [...document.querySelectorAll<HTMLElement>('[data-motion-effect]')];
  const controls = [...document.querySelectorAll<HTMLElement>('[data-motion-toggle]')];

  const apply = () => {
    const motion = effectiveMotion(choice, Boolean(media?.matches));
    document.documentElement.dataset.motion = motion;

    for (const effect of effects) {
      const protectedContext = effect.closest('form, [data-urgent-contact]') !== null;
      const offScreen = effect.dataset.motionVisible !== 'true';
      setEffectStill(effect, motion === 'reduce' || protectedContext || offScreen);
    }

    for (const control of controls) {
      control.setAttribute('aria-pressed', String(motion === 'reduce'));
    }
  };

  const toggle = () => {
    choice = document.documentElement.dataset.motion === 'reduce' ? 'allow' : 'reduce';
    try {
      window.localStorage.setItem(motionPreferenceKey, choice);
    } catch {
      // Storage may be unavailable in privacy-restricted browsing contexts.
    }
    apply();
  };

  for (const control of controls) control.addEventListener('click', toggle);

  const observer = motionWindow.IntersectionObserver
    ? new motionWindow.IntersectionObserver((entries) => {
      for (const entry of entries) {
        (entry.target as HTMLElement).dataset.motionVisible = String(entry.isIntersecting);
      }
      apply();
    })
    : undefined;

  for (const effect of effects) {
    effect.dataset.motionVisible = 'false';
    observer?.observe(effect);
  }

  if (media?.addEventListener) media.addEventListener('change', apply);
  else media?.addListener?.(apply);
  apply();

  return () => {
    for (const control of controls) control.removeEventListener('click', toggle);
    observer?.disconnect();
    if (media?.removeEventListener) media.removeEventListener('change', apply);
    else media?.removeListener?.(apply);

    // A torn-down enhancement must leave the page in the safe no-motion state.
    for (const effect of effects) setEffectStill(effect, true);
  };
}
