// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { effectiveMotion, mountMotionRuntime, resolveMotionPreset } from '../src/motion.js';

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

  it('keeps the delivered runtime source below 10 KiB gzip', () => {
    const source = readFileSync(resolve(process.cwd(), 'packages/engine/src/motion.ts'));
    expect(gzipSync(source).byteLength).toBeLessThan(10 * 1024);
  });
});
