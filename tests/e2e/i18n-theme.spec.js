const { test, expect, mockApi, pick } = require('./fixtures');

test.describe('languages', () => {
  test('lists the 10 languages and starts in English for an English browser', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await expect(page.locator('#lang option')).toHaveCount(10);
    await expect(page.locator('#lang')).toHaveValue('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('switching language translates tabs, labels, status codes and the header state', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await expect(page.locator('#connState')).toHaveText('Connected');
    await pick(page, 'lang', 'uk');
    await expect(page.locator('[data-tab="overview"]')).toHaveText('Огляд');
    await expect(page.locator('#connState')).toHaveText('Підключено');
    await expect(page.locator('#connState')).toHaveAttribute('title', 'CONNECTED');                 // raw code kept on hover
    await expect(page.locator('#alignment')).toContainText('Кут нахилу');                          // field label
    await expect(page.locator('#alignment')).toContainText('Зійшовся');                            // FILTER_CONVERGED
    await expect(page.locator('#device')).not.toContainText('HAS_ACTUATORS');
    await expect(page.locator('html')).toHaveAttribute('lang', 'uk');
  });

  for (const lang of ['en', 'uk', 'es', 'de', 'fr', 'pt', 'it', 'pl', 'zh', 'ja']) {
    test(`${lang}: no untranslated keys or raw codes are shown`, async ({ page }) => {
      await mockApi(page);
      await page.goto('/');
      await pick(page, 'lang', lang);
      const text = await page.locator('body').innerText();
      expect(text).not.toMatch(/\b(tab|card|kpi|lbl|hist|help|guide|dlg|gps|stow)\.[a-z]\w*/);
      expect(await page.locator('#device').innerText()).not.toMatch(/\b[A-Z]{3,}_[A-Z_]+\b/);
    });
  }

  test('the choice survives a reload', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await pick(page, 'lang', 'ja');
    await page.reload();
    await expect(page.locator('#lang')).toHaveValue('ja');
    await expect(page.locator('[data-tab="history"]')).toHaveText('履歴');
  });

  test.describe('browser language detection', () => {
    test.use({ locale: 'uk-UA' });
    test('picks Ukrainian for a Ukrainian browser', async ({ page }) => {
      await mockApi(page);
      await page.goto('/');
      await expect(page.locator('#lang')).toHaveValue('uk');
    });
  });

  test.describe('no Russian', () => {
    test.use({ locale: 'ru-RU' });
    test('falls back to English for a Russian browser', async ({ page }) => {
      await mockApi(page);
      await page.goto('/');
      await expect(page.locator('#lang')).toHaveValue('en');
      await expect(page.locator('#lang option[value="ru"]')).toHaveCount(0);
    });
  });
});

test.describe('theme', () => {
  test('Light / Dark set data-theme, Auto removes it, and the choice persists', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await pick(page, 'theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await pick(page, 'theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(lightBg);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await pick(page, 'theme', 'auto');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  });
});
