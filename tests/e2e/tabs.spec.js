const { test, expect, mockApi } = require('./fixtures');

test.describe('History', () => {
  test('draws the charts and the summary table', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.locator('[data-tab="history"]').click();
    await expect(page.locator('#histMeta')).toContainText('300 samples');
    await expect(page.locator('#histStats tr')).toHaveCount(6);                // header + 5 metrics
    const painted = await page.evaluate(() => {
      const c = document.getElementById('chThroughput');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
      return n;
    });
    expect(painted).toBeGreaterThan(1000);
    await expect(page.locator('#outages')).toHaveText('No outages recorded in the buffer.');
  });
});

test.describe('Obstruction map', () => {
  test('draws the sky view with compass letters and map details', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.locator('[data-tab="obstruction"]').click();
    await expect(page.locator('#obsInfo')).toContainText('Earth (north up)');
    const colours = await page.evaluate(() => {
      const c = document.getElementById('obsCanvas'), ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data; let red = 0, blue = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i] > 200 && d[i + 1] < 120 && d[i + 2] < 120) red++; if (d[i + 2] > 200 && d[i] < 120) blue++; }
      return { red, blue };
    });
    expect(colours.blue).toBeGreaterThan(colours.red);
    expect(colours.red).toBeGreaterThan(0);
    await expect(page.locator('#obsFrameNote')).toBeHidden();
  });

  test('hovering reads out direction, elevation and status', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.locator('[data-tab="obstruction"]').click();
    const box = await page.locator('#obsCanvas').boundingBox();
    const R = box.width / 2 - Math.max(22, box.width * 0.06);
    // north-east, near the edge: the mock's obstructed area
    await page.mouse.move(box.x + box.width / 2 + R * 0.6, box.y + box.height / 2 - R * 0.6);
    await expect(page.locator('#obsHover')).toHaveText(/Azimuth 45° · elevation \d+° · Obstructed/);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('#obsHover')).toHaveText(/elevation 90° · Clear/);
  });

  test('a dish-relative map hides the compass and says so', async ({ page }) => {
    await mockApi(page, { dev: { obstructionFrame: 'FRAME_UT' } });
    await page.goto('/');
    await page.locator('[data-tab="obstruction"]').click();
    await expect(page.locator('#obsFrameNote')).toHaveText('Oriented relative to the dish, not to compass north.');
  });
});

test.describe('Router', () => {
  test('reads status under the new get_status key and lists clients', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.locator('[data-tab="router"]').click();
    await expect(page.locator('#routerDevice')).toContainText('Router-01');
    await expect(page.locator('#routerClients')).toContainText('MacBook');
    await expect(page.locator('#clientCount')).toHaveText('1');
  });

  test('device and Wi-Fi cards share the row 50/50', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.locator('[data-tab="router"]').click();
    const [a, b] = await page.locator('#tab-router .card').evaluateAll(cs => cs.slice(0, 2).map(c => c.getBoundingClientRect()));
    expect(Math.abs(a.width - b.width)).toBeLessThan(2);
    expect(a.top).toBe(b.top);
  });
});

test.describe('Raw API', () => {
  test('presets come from the device and reads are sent without a dialog', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/');
    await page.locator('[data-tab="raw"]').click();
    await page.locator('#rawTarget').selectOption('router');
    await expect(page.locator('#rawPreset option')).toHaveText(['get_status', 'wifi_get_clients', 'get_device_info', 'reboot']);
    await page.locator('#rawPreset').selectOption('wifi_get_clients');
    await expect(page.locator('#rawBody')).toHaveValue('{"wifi_get_clients":{}}');
    await page.locator('#btnRawSend').click();
    await expect(page.locator('#rawOut')).toContainText('wifi_get_clients');
    await expect(page.locator('#confirmDlg')).toBeHidden();
    expect(api.posts.map(p => p.body.request)).toEqual([{ wifi_get_clients: {} }]);
  });

  test('requests that may change the device ask first', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/');
    await page.locator('[data-tab="raw"]').click();
    await page.locator('#rawBody').fill('{"dish_stow":{}}');
    await page.locator('#btnRawSend').click();
    await expect(page.locator('#dlgBody')).toContainText('“dish_stow”');
    await page.locator('#dlgCancel').click();
    expect(api.posts).toEqual([]);
    await page.locator('#btnRawSend').click();
    await page.locator('#dlgOk').click();
    await expect.poll(() => api.posts.length).toBe(1);
  });

  test('invalid JSON is rejected locally', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/');
    await page.locator('[data-tab="raw"]').click();
    await page.locator('#rawBody').fill('{nope');
    await page.locator('#btnRawSend').click();
    await expect(page.locator('.toast')).toHaveText('Request is not valid JSON');
    expect(api.posts).toEqual([]);
  });
});

test.describe('Debug data', () => {
  test('decodes pasted JSON into a searchable tree with a summary', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.locator('[data-tab="debug"]').click();
    await page.locator('#debugInput').fill(JSON.stringify({ dishGetStatus: { deviceInfo: { id: 'ut-paste', softwareVersion: '1.2.3' }, alerts: { motorsStuck: true }, downlinkThroughputBps: 5e7 } }));
    await page.locator('#btnDecode').click();
    await expect(page.locator('#debugSummaryCard')).toBeVisible();
    await expect(page.locator('#debugSummary')).toContainText('ut-paste');
    await expect(page.locator('#debugSummary')).toContainText('Motors stuck');
    await page.locator('#treeSearch').fill('softwareVersion');
    await expect(page.locator('#tree')).toContainText('1.2.3');
    await expect(page.locator('#tree')).not.toContainText('motorsStuck');
  });

  test('reports invalid JSON', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.locator('[data-tab="debug"]').click();
    await page.locator('#debugInput').fill('not json at all');
    await page.locator('#btnDecode').click();
    await expect(page.locator('.toast')).toContainText('not valid JSON');
  });
});
