import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const axeSource = require.resolve('axe-core/axe.min.js');

test('ENG-028 neutral fixture renders accessible semantic content', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Publish clear information');
  await page.addScriptTag({ path: axeSource });
  const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations);
  expect(violations).toEqual([]);
});
