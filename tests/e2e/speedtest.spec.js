const { test, expect, mockApi, mockSpeedServer, quickSpeedtest } = require('./fixtures');

async function openTab(page) {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.locator('[data-tab="speedtest"]').click();
  await expect(page.locator('#tab-speedtest')).toBeVisible();
  return mock;
}
const tileValue = (page, card, n) => page.locator(`${card} .st-tile`).nth(n).locator('.v');

test.describe('client → Internet', () => {
  test('measures latency, download and upload against the speed-test server and lists the result', async ({ page }) => {
    const hits = await mockSpeedServer(page);
    await openTab(page);
    await expect(page.locator('#stInternetStatus')).toHaveText('Not run yet.');
    await expect(tileValue(page, '#stInternet', 0)).toHaveText(/^–/);
    await quickSpeedtest(page);
    await page.locator('#btnStInternet').click();
    await expect(page.locator('#btnStInternet')).toHaveText('Stop');
    await expect(page.locator('#stInternet')).toHaveAttribute('data-phase', 'done', { timeout: 15000 });
    await expect(page.locator('#stInternetStatus')).toContainText('Done');
    await expect(page.locator('#stInternetStatus')).toContainText('speed.cloudflare.com');
    for (const n of [0, 1, 2]) await expect(tileValue(page, '#stInternet', n)).not.toHaveText(/^–/);
    const [down, up, lat] = await Promise.all([0, 1, 2].map(n => tileValue(page, '#stInternet', n).innerText()));
    expect(parseFloat(down)).toBeGreaterThan(0);
    expect(parseFloat(up)).toBeGreaterThan(0);
    expect(parseFloat(lat)).toBeGreaterThan(0);
    expect(hits.ping).toBe(4);                                  // configured number of pings
    expect(hits.down).toBeGreaterThan(0);
    expect(hits.up).toBeGreaterThan(0);
    await expect(page.locator('#btnStInternet')).toHaveText('Start');
    await expect(page.locator('#stResults tr')).toHaveCount(2);                // header + 1 result
    await expect(page.locator('#stResults tr').nth(1)).toContainText('speed.cloudflare.com');
    await expect(page.locator('#stResults tr').nth(1)).toContainText('Mbps');
  });

  test('Stop cancels the run without adding a result', async ({ page }) => {
    await mockSpeedServer(page);
    await openTab(page);
    await quickSpeedtest(page, { downSeconds: 20, downBytes: 1_000_000 });
    await page.locator('#btnStInternet').click();
    await expect(page.locator('#stInternet')).toHaveAttribute('data-phase', 'down', { timeout: 10000 });
    await page.locator('#btnStInternet').click();                               // now reads "Stop"
    await expect(page.locator('#stInternetStatus')).toHaveText('Stopped.');
    await expect(page.locator('#stInternet')).toHaveAttribute('data-phase', 'cancelled');
    await expect(page.locator('#btnStInternet')).toHaveText('Start');
    await expect(page.locator('#btnStInternet')).toBeEnabled();
    await expect(page.locator('#stResults')).toHaveText('No tests run yet.');
  });

  test('an unreachable speed-test server is reported as a failure', async ({ page }) => {
    await mockSpeedServer(page, { fail: true });
    await openTab(page);
    await quickSpeedtest(page);
    await page.locator('#btnStInternet').click();
    await expect(page.locator('#stInternet')).toHaveAttribute('data-phase', 'failed', { timeout: 10000 });
    await expect(page.locator('#stInternetStatus')).toContainText('Failed');
    await expect(page.locator('#stInternetStatus')).toContainText('speed.cloudflare.com');
    await expect(page.locator('#stResults')).toHaveText('No tests run yet.');
  });
});

test('the guide panel describes the tab and the (i) icons explain the numbers', async ({ page }) => {
  await openTab(page);
  await page.locator('#btnGuide').click();
  await expect(page.locator('#guideTitle')).toHaveText('Speed test');
  await expect(page.locator('#guideBody li')).toHaveCount(3);
  await expect(page.locator('#guideBody')).toContainText('Cloudflare');
  await page.keyboard.press('Escape');
  await page.locator('#stInternet .st-tile').nth(2).locator('.info').click();
  await expect(page.locator('#tip')).toContainText('Median round-trip time');
});
