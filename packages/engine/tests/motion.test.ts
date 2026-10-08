// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { effectiveMotion, mountMotionRuntime, resolveDeclaredMotionPreset, resolveMotionPreset } from '../src/motion.js';

describe('ENG-015 motion preference', () => {
  it('gives explicit reduce precedence and uses OS only without a choice', () => {
    expect(effectiveMotion('reduce', false)).toBe('reduce');
    expect(effectiveMotion('allow', true)).toBe('allow');
    expect(effectiveMotion(null, true)).toBe('reduce');
  });

  it('uses a supported selected preset, then a supported declared intent, else still', () => {
    const supported = new Set(['fade', 'subtle']);
    expect(resolveMotionPreset('subtle', 'fade', supported)).toBe('fade');
    expect(resolveMotionPreset('subtle', 'removed-preset', supported)).toBe('subtle');
    expect(resolveMotionPreset('ambient', 'removed-preset', supported)).toBeUndefined();
    expect(resolveMotionPreset('none', 'fade', supported)).toBeUndefined();
  });

  it('uses a theme intent map only when its target is supported', () => {
    const supported = new Set(['fade']);
    expect(resolveMotionPreset('subtle', 'removed-preset', supported, new Map([['subtle', 'fade']]))).toBe('fade');
    expect(resolveMotionPreset('ambient', 'removed-preset', supported, new Map([['subtle', 'fade']]))).toBeUndefined();
    expect(resolveMotionPreset('subtle', 'removed-preset', supported, new Map([['subtle', 'zoom']]))).toBeUndefined();
  });

  it('uses only declared target fallbacks when projecting across themes', () => {
    const supported = new Set(['subtle', 'fade']);
    expect(resolveDeclaredMotionPreset('subtle', 'foreign', supported)).toBeUndefined();
    expect(resolveDeclaredMotionPreset('subtle', 'foreign', supported, new Map([['subtle', 'fade']]))).toBe('fade');
    expect(resolveDeclaredMotionPreset('none', 'fade', supported, new Map([['none', 'fade']]))).toBeUndefined();
  });

  it('tears down listeners and leaves each effect still', () => {
    document.body.innerHTML = [
      '<button data-motion-toggle aria-pressed="false">Reduce motion</button>',
      '<video data-motion-effect poster="/still.svg"></video>',
    ].join('');
    const video = document.querySelector('video')!;
    const pause = vi.fn();
    Object.defineProperty(video, 'pause', { configurable: true, value: pause });

    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const media = { matches: false, addEventListener, removeEventListener } as unknown as MediaQueryList;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => media) });

    let observerCallback: IntersectionObserverCallback | undefined;
    const disconnect = vi.fn();
    class Observer {
      constructor(callback: IntersectionObserverCallback) { observerCallback = callback; }
      observe = vi.fn();
      disconnect = disconnect;
      takeRecords = vi.fn(() => []);
      unobserve = vi.fn();
      root = null;
      rootMargin = '0px';
      thresholds: readonly number[] = [];
    }
    Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: Observer });

    const teardown = mountMotionRuntime(document, window);
    observerCallback?.([{ target: video, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(video.dataset.motionPaused).toBe('false');

    teardown();
    expect(video.dataset.motionPaused).toBe('true');
    expect(pause).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    document.querySelector<HTMLButtonElement>('[data-motion-toggle]')!.click();
    expect(document.documentElement.dataset.motion).toBe('allow');
  });

  it('lets an opted-in theme controller keep OS reduction, labels, and host effects in sync', () => {
    document.documentElement.dataset.motionController = 'engine';
    document.documentElement.dataset.motionStorageKey = 'fixture-motion-preference';
    window.localStorage.clear();
    window.localStorage.setItem('fixture-motion-preference', 'allow');
    document.body.innerHTML = [
      '<button data-motion-toggle aria-pressed="false">Reduce motion</button>',
      '<video data-motion-effect poster="/still.svg"></video>',
      '<form><video data-motion-effect poster="/still.svg"></video></form>',
    ].join('');
    const [effect, protectedEffect] = [...document.querySelectorAll<HTMLVideoElement>('[data-motion-effect]')];
    const pause = vi.fn();
    Object.defineProperty(effect, 'pause', { configurable: true, value: pause });
    Object.defineProperty(protectedEffect, 'pause', { configurable: true, value: pause });

    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const media = {
      matches: true,
      addEventListener: vi.fn((_event: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
      removeEventListener: vi.fn((_event: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    };
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => media as unknown as MediaQueryList) });

    let observerCallback: IntersectionObserverCallback | undefined;
    class Observer {
      constructor(callback: IntersectionObserverCallback) { observerCallback = callback; }
      observe = vi.fn(); disconnect = vi.fn(); takeRecords = vi.fn(() => []); unobserve = vi.fn();
      root = null; rootMargin = '0px'; thresholds: readonly number[] = [];
    }
    Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: Observer });

    const teardown = mountMotionRuntime(document, window);
    const control = document.querySelector<HTMLButtonElement>('[data-motion-toggle]')!;
    expect(document.documentElement.dataset.motion).toBe('reduce');
    expect(document.documentElement.dataset.motionPreference).toBe('reduce');
    expect(control.getAttribute('aria-pressed')).toBe('true');
    expect(control.textContent).toBe('Allow motion');

    observerCallback?.([
      { target: effect, isIntersecting: true } as IntersectionObserverEntry,
      { target: protectedEffect, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
    expect(effect.dataset.motionPaused).toBe('true');
    expect(protectedEffect.dataset.motionPaused).toBe('true');

    media.matches = false;
    for (const listener of listeners) listener({ matches: false } as MediaQueryListEvent);
    expect(document.documentElement.dataset.motion).toBe('allow');
    expect(document.documentElement.dataset.motionPreference).toBe('allow');
    expect(control.getAttribute('aria-pressed')).toBe('false');
    expect(control.textContent).toBe('Reduce motion');
    expect(effect.dataset.motionPaused).toBe('false');
    expect(protectedEffect.dataset.motionPaused).toBe('true');

    control.click();
    expect(window.localStorage.getItem('fixture-motion-preference')).toBe('reduce');
    expect(document.documentElement.dataset.motion).toBe('reduce');
    teardown();
    expect(effect.dataset.motionPaused).toBe('true');
    expect(document.documentElement.dataset.motion).toBe('reduce');
    expect(document.documentElement.dataset.motionPreference).toBe('reduce');
    expect(control.getAttribute('aria-pressed')).toBe('true');
    expect(control.textContent).toBe('Allow motion');

    const remount = mountMotionRuntime(document, window);
    expect(document.documentElement.dataset.motion).toBe('reduce');
    expect(document.documentElement.dataset.motionPreference).toBe('reduce');
    remount();
    delete document.documentElement.dataset.motionController;
    delete document.documentElement.dataset.motionStorageKey;
  });

  it('uses a readable static ceiling for an opted-in theme without IntersectionObserver', () => {
    document.documentElement.dataset.motionController = 'engine';
    window.localStorage.clear();
    window.localStorage.setItem('site-engine:motion', 'allow');
    document.body.innerHTML = '<button data-motion-toggle aria-pressed="false">Reduce motion</button><div data-motion-effect>Readable content</div>';
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
    Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: undefined });

    const teardown = mountMotionRuntime(document, window);
    expect(document.documentElement.dataset.motion).toBe('reduce');
    expect(document.documentElement.dataset.motionPreference).toBe('reduce');
    expect(document.querySelector<HTMLElement>('[data-motion-effect]')!.dataset.motionPaused).toBe('true');
    expect(document.querySelector<HTMLButtonElement>('[data-motion-toggle]')!.textContent).toBe('Allow motion');
    teardown();
    delete document.documentElement.dataset.motionController;
  });
});
