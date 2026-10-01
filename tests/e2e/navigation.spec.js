const { test, expect, mockApi, pick } = require('./fixtures');

test.describe('header menu', () => {
  test('controls are hidden until the ☰ button is used', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await expect(page.locator('#menuPanel')).toBeHidden();
    await page.locator('#btnMenu').click();
    await expect(page.locator('#menuPanel')).toBeVisible();
    await expect(page.locator('#btnMenu')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#interval')).toBeVisible();
    await expect(page.locator('#btnExport')).toBeVisible();
  });

  test('stays open while changing settings; Esc and outside click close it', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.locator('#btnMenu').click();
    await page.locator('#theme').selectOption('light');
    await page.locator('#lang').selectOption('fr');
    await expect(page.locator('#menuPanel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#menuPanel')).toBeHidden();
    await expect(page.locator('#btnMenu')).toBeFocused();
    await page.locator('#btnMenu').click();
    await page.mouse.click(700, 600);
    await expect(page.locator('#menuPanel')).toBeHidden();
  });

  test('Export snapshot downloads JSON with the loaded data', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await expect(page.locator('#connState')).toHaveText('Connected');
    await page.locator('#btnMenu').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#btnExport').click()]);
    expect(download.suggestedFilename()).toMatch(/^starlink-snapshot-.*\.json$/);
    const snap = JSON.parse(require('fs').readFileSync(await download.path(), 'utf8'));
    expect(snap.dishGetStatus.deviceInfo.id).toBe('ut00000000-00000000-00example');
    await expect(page.locator('#menuPanel')).toBeHidden();
  });

  test('refresh interval is remembered', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await pick(page, 'interval', '10000');
    await page.reload();
    await expect(page.locator('#interval')).toHaveValue('10000');
  });
});

test.describe('tabs', () => {
  test('switching tabs shows one section at a time and is remembered', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    for (const tab of ['history', 'obstruction', 'router', 'speedtest', 'debug', 'raw', 'overview']) {
      await page.locator(`[data-tab="${tab}"]`).click();
      await expect(page.locator(`#tab-${tab}`)).toBeVisible();
      await expect(page.locator('section.tab:visible')).toHaveCount(1);
    }
    await page.locator('[data-tab="router"]').click();
    await page.reload();
    await expect(page.locator('#tab-router')).toBeVisible();
  });
});

test.describe('About this tab panel', () => {
  test('opens with content for the current tab, traps focus, Esc closes and returns focus', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.locator('[data-tab="history"]').click();
    await page.locator('#btnGuide').click();
    const panel = page.locator('#guide');
    await expect(panel).toBeVisible();
    await expect(page.locator('#guideTitle')).toHaveText('History');
    await expect(page.locator('#guideBody li')).toHaveCount(3);
    await expect(page.locator('#btnGuideClose')).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.getElementById('guide').contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.locator('#btnGuide')).toBeFocused();
  });

  test('backdrop click closes it; content follows the language', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await pick(page, 'lang', 'pl');
    await page.locator('#btnGuide').click();
    await expect(page.locator('#guideTitle')).toHaveText('Przegląd');
    await expect(page.locator('#guideBody')).toContainText('Co możesz tu zrobić');
    await page.locator('#guideBackdrop').click({ position: { x: 50, y: 400 } });
    await expect(page.locator('#guide')).toBeHidden();
  });

  test('the guide button does not change the active tab', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.locator('#btnGuide').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-tab="overview"]')).toHaveClass(/active/);
  });
});
