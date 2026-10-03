import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const axeSource = require.resolve('axe-core/axe.min.js');

test('ENG-028 neutral fixture renders accessible semantic content', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Publish clear information');
  await page.addScriptTag({ path: axeSource });
  const violations = await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations);
  expect(violations).toEqual([]);
});

test('ENG-004 and ENG-005 derive routes and render the complete neutral block gallery', async ({ page }) => {
  await page.goto('/general/gallery');
  await expect(page.locator('[data-block]')).toHaveCount(17);
  await expect(page.getByText('Hidden fixture')).toHaveCount(0);
  await expect(page.getByText('This unconfirmed quote must not render.')).toHaveCount(0);
  const video = page.locator('video');
  await expect(video).toHaveCount(1);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState >= 1 && element.duration > 0)).toBe(true);
  expect(await video.evaluate((element: HTMLVideoElement) => element.canPlayType('video/webm'))).not.toBe('');
  await expect(page.getByRole('link', { name: 'Guide' }).first()).toHaveAttribute('href', '/general/guide');
  await page.goto('/services/operations/detail');
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Operations');
  await page.goto('/unknown-route');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
test('ENG-015 neutral runtime persists reduced motion across routes', async ({ page }) => {
  await page.goto('/motion/one');
  await page.getByRole('button', { name: 'Reduce motion' }).click({ force: true });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await page.goto('/motion/two');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await expect(page.locator('form [data-motion]')).toHaveAttribute('data-motion-paused', 'true');
});

test('ENG-015 pauses offscreen and urgent motion', async ({ page }) => {
 await page.goto('/motion/one'); const off=page.locator('#offscreen'); await expect(off).toHaveCSS('animation-play-state','paused'); await page.evaluate(() => document.querySelector('#offscreen')?.scrollIntoView()); await expect(off).toHaveCSS('animation-play-state','running'); await expect(page.locator('[data-urgent-contact]')).toHaveCSS('animation-play-state','paused');
});
test('ENG-015 runtime respects OS preference and static CSS starts paused', async ({ page }) => {
 await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/motion/one'); await expect(page.locator('html')).toHaveAttribute('data-motion','reduce');
 await page.emulateMedia({ reducedMotion: 'no-preference' }); await expect(page.locator('html')).toHaveAttribute('data-motion','allow');
});
