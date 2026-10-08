import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
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
  expect(await page.locator('[data-block]').evaluateAll((blocks) => blocks.map((block) => block.getAttribute('data-block')))).toEqual(expect.arrayContaining([
    'incidentBar', 'pillarGrid', 'featureGrid', 'splitList', 'chipList', 'testimonials', 'faq', 'callout', 'relatedServices', 'cta', 'richText', 'contact', 'media', 'imageText', 'gallery', 'logoStrip', 'video',
  ]));
  await expect(page.getByText('Hidden fixture')).toHaveCount(0);
  await expect(page.getByText('HIDDEN_TESTIMONIAL_MUST_NOT_RENDER')).toHaveCount(0);
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

test('ENG-005 starter blocks retain their semantic HTML and omit hidden content', async ({ page }) => {
  await page.goto('/general/gallery');
  await expect(page.locator('[data-block="incidentBar"] [role="status"]')).toHaveCount(1);
  await expect(page.locator('[data-block="pillarGrid"] ul.cards > li.card')).toHaveCount(2);
  await expect(page.locator('[data-block="featureGrid"] ul.cards > li.card')).toHaveCount(2);
  await expect(page.locator('[data-block="splitList"] ol.split > li')).toHaveCount(2);
  await expect(page.locator('[data-block="chipList"] ul.chips > li')).toHaveCount(3);
  await expect(page.locator('[data-block="testimonials"] figure.quote blockquote')).toHaveCount(1);
  await expect(page.locator('[data-block="faq"] details > summary')).toHaveCount(2);
  await expect(page.locator('[data-block="callout"] ul')).toHaveCount(0);
  await expect(page.locator('[data-block="relatedServices"] ul > li')).toHaveCount(1);
  await expect(page.locator('[data-block="cta"] h2')).toHaveCount(1);
  await expect(page.locator('[data-block="richText"] p')).toHaveCount(1);
  await expect(page.locator('[data-block="contact"]')).toContainText('This synthetic contact block accepts a secure inquiry.');
  await expect(page.locator('[data-block="media"] figure img')).toHaveCount(1);
  await expect(page.locator('[data-block="imageText"] picture + div h2')).toHaveCount(1);
  await expect(page.locator('[data-block="gallery"] ul.cards > li img')).toHaveCount(2);
  await expect(page.locator('[data-block="logoStrip"] ul.cards > li img')).toHaveCount(1);
  await expect(page.locator('[data-block="video"] video track[kind="captions"]')).toHaveCount(1);
  await expect(page.locator('[data-block-id="40000000-0000-4000-8000-000000000022"]')).toHaveCount(0);
});

test('listing routes progressively filter canonical pages', async ({ page, browser }) => {
  await page.goto('/insights/all');
  const listing = page.locator('[data-page-listing]');
  await expect(listing).toHaveAttribute('data-page-listing-kind', 'articles');
  await expect(listing.locator('[data-page-listing-item]')).toHaveCount(7);
  await expect(listing.locator('[data-page-listing-item]:not([hidden])')).toHaveCount(6);
  const query = listing.locator('[data-page-listing-query]');
  await query.focus();
  await page.keyboard.type('article 7');
  await expect(listing.locator('[data-page-listing-count]')).toHaveText('1 result');
  await expect(listing.locator('[data-page-listing-item]:not([hidden]) [data-page-listing-title]')).toHaveText('Article 7');
  await expect(listing.locator('[data-page-listing-reset]')).toBeVisible();
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(query).toBeFocused();
  await expect(listing.locator('[data-page-listing-pagination]')).toBeVisible();
  await page.getByRole('button', { name: 'Page 2' }).press('Enter');
  await expect(listing.locator('[data-page-listing-item]:not([hidden]) [data-page-listing-title]')).toHaveText('Article 7');
  await expect(listing.locator('[data-page-listing-results]')).toBeFocused();
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-page-listing]')!;
    const url = new URL(location.href);
    url.searchParams.set(`${root.dataset.pageListingId}-page`, '2.5');
    url.searchParams.set('unrelated', 'preserved');
    history.replaceState({ marker: 'preserved' }, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(listing.locator('[data-page-listing-item]:not([hidden]) [data-page-listing-title]')).toHaveText('Article 7');
  await expect.poll(() => page.evaluate(() => history.state)).toEqual({ marker: 'preserved' });
  await expect(page).toHaveURL(/unrelated=preserved/);
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-page-listing]')!;
    const url = new URL(location.href);
    url.searchParams.set(`${root.dataset.pageListingId}-page`, 'Infinity');
    history.replaceState({ marker: 'still-preserved' }, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(listing.locator('[data-page-listing-item]:not([hidden])')).toHaveCount(6);
  await expect(page).not.toHaveURL(/Infinity/);
  await expect.poll(() => page.evaluate(() => history.state)).toEqual({ marker: 'still-preserved' });
  await query.fill('does not occur');
  await expect(listing.locator('[data-page-listing-empty]')).toBeVisible();
  await expect(listing.locator('[data-page-listing-item]:not([hidden])')).toHaveCount(0);

  await page.goto('/careers/all');
  const jobs = page.locator('[data-page-listing]');
  await expect(jobs).toHaveAttribute('data-page-listing-kind', 'jobs');
  await jobs.locator('[data-page-listing-query]').fill('sample city');
  await expect(jobs.locator('[data-page-listing-count]')).toHaveText('1 result');
  await jobs.locator('[data-page-listing-query]').fill('unavailable');
  await expect(jobs.locator('[data-page-listing-empty]')).toBeVisible();
  await expect(jobs.locator('[data-page-listing-pagination]')).toBeHidden();

  const noJavaScript = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noJavaScript.newPage();
  await staticPage.goto('/insights/all');
  await expect(staticPage.locator('[data-page-listing-item]')).toHaveCount(7);
  await expect(staticPage.locator('[data-page-listing-controls]')).toBeHidden();
  await expect(staticPage.locator('[data-page-listing-item] a').last()).toHaveAttribute('href', '/insights/all/article-7');
  await staticPage.goto('/insights/empty');
  await expect(staticPage.locator('[data-page-listing-empty]')).toHaveText('No matching pages.');
  await expect(staticPage.locator('[data-page-listing-controls]')).toBeHidden();
  await noJavaScript.close();

  await page.addScriptTag({ path: axeSource });
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([]);
});

test('ENG-038 starter fixture matrix renders every declared surface at desktop and mobile', async ({ page }, testInfo) => {
  const standardBlocks = ['hero', 'incidentBar', 'pillarGrid', 'featureGrid', 'splitList', 'chipList', 'testimonials', 'faq', 'callout', 'relatedServices', 'cta', 'richText', 'contact', 'media', 'imageText', 'gallery', 'logoStrip', 'video'];
  await page.goto('/');
  await expect(page.locator('[data-block="hero"]')).toHaveCount(1);
  await page.goto('/general/gallery');
  expect(await page.locator('[data-block]').evaluateAll(blocks => blocks.map(block => block.getAttribute('data-block')))).toEqual(expect.arrayContaining(standardBlocks.filter(type => type !== 'hero')));
  await expect(page.getByText('Short copy.')).toBeVisible();
  await expect(page.getByText('Longer synthetic copy demonstrates a resilient card layout without depending on a real client message.')).toBeVisible();
  await expect(page.locator('[data-block="media"] img, [data-block="imageText"] img, [data-block="gallery"] img, [data-block="logoStrip"] img')).toHaveCount(5);
  await expect(page.locator('video')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('starter-gallery-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('starter-gallery-mobile.png'), fullPage: true });
  await page.addScriptTag({ path: axeSource });
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations)).toEqual([]);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await expect(page.locator('[data-motion-effect]').first()).toHaveAttribute('data-motion-paused', 'true');
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Starter Sans"'))).toBe(true);
  for (const [path, heading] of [['/general/guide', 'Guide'], ['/general/article', 'Article'], ['/insights/all', 'Insights'], ['/services/operations', 'Operations'], ['/services/operations/detail', 'Service detail'], ['/careers/example-role', 'Example role']] as const) { await page.goto(path); await expect(page.getByRole('heading', { level: 1 })).toContainText(heading); }
  await page.goto('/unknown-fixture');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
test('ENG-015 neutral runtime persists reduced motion across routes', async ({ page }) => {
  await page.goto('/motion/one');
  await page.getByRole('button', { name: 'Reduce motion' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await page.goto('/motion/two');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await expect(page.locator('form [data-motion-effect]')).toHaveAttribute('data-motion-paused', 'true');
});

test('ENG-015 pauses offscreen and urgent motion', async ({ page }) => {
 await page.goto('/motion/one'); const off=page.locator('#offscreen'); await expect(off).toHaveCSS('animation-play-state','paused'); await page.evaluate(() => document.querySelector('#offscreen')?.scrollIntoView()); await expect(off).toHaveCSS('animation-play-state','running'); await expect(page.locator('[data-urgent-contact]')).toHaveCSS('animation-play-state','paused');
 await expect.poll(() => page.getByLabel('Urgent motion fixture video').evaluate((element: HTMLVideoElement) => element.paused)).toBe(true); await expect.poll(() => page.getByLabel('Form motion fixture video').evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
 const video = page.getByLabel('Motion fixture video', { exact: true }); await expect(video).toHaveAttribute('poster', '/media/sample-poster.svg'); await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
});
test('ENG-015 runtime respects OS preference and static CSS starts paused', async ({ page }) => {
 await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/motion/one'); await expect(page.locator('html')).toHaveAttribute('data-motion','reduce'); await expect(page.getByLabel('Motion fixture video', { exact: true })).toHaveAttribute('data-motion-paused', 'true');
 await page.emulateMedia({ reducedMotion: 'no-preference' }); await expect(page.locator('html')).toHaveAttribute('data-motion','allow');
});

test('ENG-015 engine-controller pages without effects retain a working persisted footer preference', async ({ page }) => {
 await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.goto('/motion/zero');
 await expect(page.locator('html')).toHaveAttribute('data-motion-controller', 'engine');
 await expect(page.locator('[data-motion-effect]')).toHaveCount(0);
 await page.getByRole('button', { name: 'Reduce motion' }).click();
 await expect(page.locator('html')).toHaveAttribute('data-motion-preference', 'reduce');
 await expect.poll(() => page.evaluate(() => localStorage.getItem('site-engine:motion'))).toBe('reduce');
 await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-motion-preference', 'reduce');
 await page.getByRole('button', { name: 'Allow motion' }).click();
 await expect.poll(() => page.evaluate(() => localStorage.getItem('site-engine:motion'))).toBe('allow');
 await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(page.locator('html')).toHaveAttribute('data-motion-preference', 'reduce');
 await page.emulateMedia({ reducedMotion: 'no-preference' }); await expect(page.locator('html')).toHaveAttribute('data-motion-preference', 'allow');
});

test('ENG-015 engine-controller falls back to readable still content without IntersectionObserver', async ({ browser }) => {
 const context = await browser.newContext(); await context.addInitScript(() => { Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: undefined }); });
 const page = await context.newPage(); await page.goto('/motion/zero');
 await expect(page.getByRole('heading', { name: 'Motion fixture' })).toBeVisible();
 await expect(page.locator('html')).toHaveAttribute('data-motion-preference', 'reduce');
 await expect(page.getByRole('button', { name: 'Allow motion' })).toBeVisible();
 await context.close();
});

test('ENG-015 no-JS fixture remains readable and paused', async ({ browser }) => { const context=await browser.newContext({ javaScriptEnabled:false }); const page=await context.newPage(); await page.goto('/motion/one'); await expect(page.getByRole('heading')).toBeVisible(); await expect(page.locator('[data-motion-effect]').first()).toHaveCSS('animation-play-state','paused'); await context.close(); });
test('ENG-015 toggle works when storage is blocked', async ({ page }) => { await page.addInitScript(() => { Storage.prototype.getItem=()=>{throw new Error('blocked')}; Storage.prototype.setItem=()=>{throw new Error('blocked')} }); await page.goto('/motion/one'); await page.getByRole('button',{name:'Reduce motion'}).click(); await expect(page.locator('html')).toHaveAttribute('data-motion','reduce'); await expect(page.getByRole('button',{name:'Reduce motion'})).toHaveAttribute('aria-pressed','true'); });

test('ENG-015 motion fixture has no automated accessibility violations', async ({ page }) => {
  await page.goto('/motion/one');
  await page.addScriptTag({ path: axeSource });
  const violations = await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations);
  expect(violations).toEqual([]);
});

test('ENG-015 delivers a motion runtime below 10 KiB gzip', async ({ page, request }) => {
  await page.goto('/motion/one');
  const modules = await page.locator('script[type="module"]').evaluateAll((scripts) => scripts.map((script) => ({
    code: script.textContent ?? '',
    src: script.getAttribute('src'),
  })));
  const externalModules = await Promise.all(modules.filter((module) => module.src).map(async (module) => {
    const response = await request.get(new URL(module.src!, page.url()).toString());
    expect(response.ok()).toBe(true);
    return response.body();
  }));
  const deliveredCode = Buffer.concat([
    ...modules.map((module) => Buffer.from(module.code)),
    ...externalModules,
  ]);
  expect(deliveredCode.byteLength).toBeGreaterThan(0);
  expect(gzipSync(deliveredCode).byteLength).toBeLessThan(10 * 1024);
});

test('ENG-015 enhances real starter pages for OS preference and persisted choice', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await expect(page.locator('[data-motion-effect="subtle"]')).toHaveAttribute('data-motion-paused', 'true');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Reduce motion' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await page.goto('/general/gallery');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await expect(page.locator('#motion-offscreen')).toHaveAttribute('data-motion-paused', 'true');
  await expect(page.locator('[data-block="incidentBar"]')).not.toHaveAttribute('data-motion-effect');
  await expect(page.locator('[data-block="contact"]')).not.toHaveAttribute('data-motion-effect');
});

test('ENG-015 lets an explicit Allow motion choice override OS reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const effect = page.locator('[data-motion-effect="subtle"]');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await page.getByRole('button', { name: 'Reduce motion' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'allow');
  await expect(effect).toHaveAttribute('data-motion-paused', 'false');
  await expect(effect).toHaveCSS('animation-play-state', 'running');
  await expect(effect).toHaveCSS('animation-duration', '2s');
  await page.getByRole('button', { name: 'Reduce motion' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await expect(effect).toHaveAttribute('data-motion-paused', 'true');
  await expect(effect).toHaveCSS('animation-play-state', 'paused');
});

test('ENG-015 starts real starter effects still and leaves non-opt-in no-motion pages inert', async ({ page, browser }) => {
  await page.goto('/general/gallery');
  const offscreen = page.locator('#motion-offscreen');
  await expect(offscreen).toHaveCSS('animation-play-state', 'paused');
  await page.evaluate(() => document.querySelector('#motion-offscreen')?.scrollIntoView());
  await expect(offscreen).toHaveCSS('animation-play-state', 'running');

  await page.goto('/general/guide');
  await expect(page.locator('[data-motion-effect]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reduce motion' })).toHaveCount(0);

  const noJavaScript = await browser.newContext({ javaScriptEnabled: false });
  const noJavaScriptPage = await noJavaScript.newPage();
  await noJavaScriptPage.goto('/');
  await expect(noJavaScriptPage.getByRole('heading', { level: 1 })).toHaveText('Publish clear information');
  await expect(noJavaScriptPage.locator('[data-motion-effect="subtle"]')).toHaveCSS('animation-play-state', 'paused');
  await noJavaScript.close();
});

test('ENG-024 searches published static content with accessible canonical results', async ({ page }) => {
  await page.goto('/');
  const search = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Search' });
  await expect(search).toHaveAttribute('href', '/search');
  await search.click();
  await expect(page).toHaveURL(/\/search\/?$/);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  await page.getByLabel('Search published content').fill('guide neutral');
  await page.getByLabel('Search published content').press('Enter');
  await expect(page.getByRole('status')).toContainText('result');
  const guide = page.locator('#content').getByRole('link', { name: 'Guide' });
  await expect(guide).toHaveAttribute('href', '/general/guide');
  await guide.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/general\/guide\/?$/);
  await page.route('**/search-index.json', async (route) => route.fulfill({ status: 503 }));
  await page.goto('/search');
  await page.getByLabel('Search published content').fill('guide');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('status')).toHaveText('Search is temporarily unavailable. Please try again.');
  await page.unroute('**/search-index.json');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('status')).toContainText('result');
  await page.getByLabel('Search published content').fill('DRAFT_ONLY_SEARCH_MARKER');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('status')).toHaveText('No published pages match your search.');
  await page.addScriptTag({ path: axeSource });
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([]);
});
