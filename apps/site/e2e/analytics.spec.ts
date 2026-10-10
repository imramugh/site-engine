import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axeSource = require.resolve('axe-core/axe.min.js');

test('ENG-025 leaves measurement absent and accessible when no endpoint is configured', async ({ page }) => {
  const collectorRequests: string[] = [];
  page.on('request', request => {
    if (/analytics|collect|telemetry/i.test(request.url())) collectorRequests.push(request.url());
  });

  await page.goto('/');
  await expect(page.locator('[data-analytics-consent]')).toHaveCount(0);
  await expect(page.locator('[data-analytics-grant], [data-analytics-revoke]')).toHaveCount(0);
  expect(collectorRequests).toEqual([]);

  await page.addScriptTag({ path: axeSource });
  const violations = await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] },
  })).violations);
  expect(violations).toEqual([]);
});
