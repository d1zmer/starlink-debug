const { test, expect, mockApi } = require('./fixtures');

test('stat tiles show the dish values', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  const tiles = page.locator('#kpis .kpi');
  await expect(tiles).toHaveCount(8);
  await expect(tiles.nth(0)).toContainText('143');       // 142.6 Mbps download
  await expect(tiles.nth(2)).toContainText('31.4');      // latency
  await expect(tiles.nth(6)).toContainText('14');        // GPS satellites
});

test('active alerts are counted and highlighted', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.locator('#alertCount')).toHaveText('1 active');
  await expect(page.locator('#alerts .chip.bad')).toHaveText('Thermal throttling');
});

test('ready-state chips show ready / not ready', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.locator('#ready .chip.bad')).toHaveText('cady: not ready');
  await expect(page.locator('#ready .chipwrap .chip.ok')).toHaveCount(5);
});

test.describe('tooltips', () => {
  test('hover shows the description; it hides again when the pointer leaves', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.locator('#kpis .kpi').nth(3).locator('.info').hover();
    await expect(page.locator('#tip')).toBeVisible();
    await expect(page.locator('#tip')).toContainText('below 3%');
    await page.mouse.move(5, 700);
    await expect(page.locator('#tip')).toBeHidden();
  });

  test('click pins it, Esc closes it, and keyboard focus opens it', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    const icon = page.locator('#ready .chipwrap .info').first();      // cady
    await icon.click();
    await page.mouse.move(5, 700);
    await expect(page.locator('#tip')).toContainText('60 MHz');       // still open: pinned
    await page.keyboard.press('Escape');
    await expect(page.locator('#tip')).toBeHidden();
    await page.locator('#device .info').first().focus();
    await expect(page.locator('#tip')).toBeVisible();
    await expect(icon).toHaveAttribute('aria-label', /What does this mean\?/);
  });

  test('every property row has an icon that stays on the label line', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    const cells = '#tab-overview table.kv:not(#probe table) td:first-child';   // the environment check has no properties
    const rows = await page.locator(cells).count();
    expect(rows).toBeGreaterThan(20);
    await expect(page.locator(`${cells} .info`)).toHaveCount(rows);
    const orphans = await page.evaluate(() => [...document.querySelectorAll('#tab-overview table.kv td:first-child, #kpis .l')].filter(td => td.querySelector('.info'))
      .filter(td => { const i = td.querySelector('.info').getBoundingClientRect(), c = td.getBoundingClientRect(); return i.left - c.left < 8 && c.height > 30; })
      .map(td => td.innerText));
    expect(orphans).toEqual([]);
  });
});

test('refresh icon reloads status and spins while loading', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/');
  await expect(page.locator('#connState')).toHaveText('Connected');
  api.override('status', route => new Promise(r => setTimeout(() => r({ ok: true, data: { dishGetStatus: { deviceInfo: {}, alerts: {} } } }), 400)));
  const before = api.requests.filter(c => c === 'status').length;
  await page.locator('#btnRefresh').click();
  await expect(page.locator('#btnRefresh')).toHaveClass(/spinning/);
  await expect(page.locator('#btnRefresh')).not.toHaveClass(/spinning/, { timeout: 5000 });
  expect(api.requests.filter(c => c === 'status').length).toBe(before + 1);
});

test('an unreachable dish shows the error banner', async ({ page }) => {
  const api = await mockApi(page);
  api.override('status', { ok: false, error: 'Failed to dial target host', hint: 'Dish not reachable on 192.168.100.1:9200.' });
  await page.goto('/');
  await expect(page.locator('#banner')).toContainText('Dish not reachable');
  await expect(page.locator('#connState')).toHaveText('unreachable');
});
