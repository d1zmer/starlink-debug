// Runs in the "phone" project (Pixel 7 viewport) and the desktop one.
const { test, expect, mockApi } = require('./fixtures');

test('no horizontal page scroll on any tab', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  for (const tab of ['overview', 'history', 'obstruction', 'router', 'speedtest', 'debug', 'raw']) {
    await page.locator(`[data-tab="${tab}"]`).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), tab).toBe(true);
  }
});

test('menu, guide panel and tooltips fit inside the viewport', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  const inside = sel => page.locator(sel).evaluate(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5; });
  await page.locator('#btnMenu').click();
  expect(await inside('#menuPanel')).toBe(true);
  await page.keyboard.press('Escape');
  await page.locator('#kpis .info').first().click();
  expect(await inside('#tip')).toBe(true);
  await page.keyboard.press('Escape');
  await page.locator('#btnGuide').click();
  await expect(page.locator('#guide')).toBeVisible();
  await expect.poll(() => inside('#guide')).toBe(true);          // after the slide-in animation
});
