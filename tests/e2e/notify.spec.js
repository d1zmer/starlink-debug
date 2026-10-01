// Outage notifications (☰ menu): a fake `Notification` records what the page would show,
// page.clock controls Date.now(), and status polls are triggered by hand (auto-refresh is off in tests).
const { test, expect, mockApi, pick, makeStatus } = require('./fixtures');

/** Replace window.Notification with a recorder. `permission` is the initial state; requestPermission() grants. */
async function fakeNotifications(page, permission = 'granted') {
  await page.addInitScript(perm => {
    const shown = [];
    class FakeNotification {
      constructor(title, opts = {}) { this.title = title; this.body = opts.body; this.tag = opts.tag; this.requireInteraction = !!opts.requireInteraction; shown.push(this); }
      close() {}
      static requestPermission() { FakeNotification.permission = 'granted'; localStorage.setItem('__fakePerm', 'granted'); FakeNotification.asked = (FakeNotification.asked || 0) + 1; return Promise.resolve('granted'); }
    }
    FakeNotification.permission = localStorage.getItem('__fakePerm') || perm;   // a real browser remembers the grant across reloads
    window.Notification = FakeNotification;
    window.__shown = shown;
  }, permission);
}

const shown = page => page.evaluate(() => window.__shown.map(n => ({ title: n.title, body: n.body, sticky: n.requireInteraction })));
const poll = page => page.evaluate(() => refreshStatus());
const bad = state => ({ ok: true, data: { dishGetStatus: { ...makeStatus({}).dishGetStatus, state } }, ms: 5 });

/** Advance the fake clock and poll once. */
async function pollAfter(page, ms) { await page.clock.runFor(ms); await poll(page); }
/** Fake Date/timers: install before goto, then freeze at 12:00:00 once the page is up (deterministic times). */
const installClock = page => page.clock.install({ time: new Date('2026-10-01T11:59:00') });
const freezeClock = page => page.clock.pauseAt(new Date('2026-10-01T12:00:00'));

test.describe('outage notifications', () => {
  test('menu switch asks the browser once, enables polling and is remembered', async ({ page }) => {
    await fakeNotifications(page, 'default');
    await mockApi(page);
    await page.goto('/');
    await page.locator('#btnMenu').click();
    const sw = page.locator('#notifySwitch');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#notifySoundSwitch')).toBeDisabled();
    await expect(page.locator('#btnNotifyTest')).toBeDisabled();
    await expect(page.locator('#notifyHint')).toBeHidden();

    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => Notification.asked)).toBe(1);
    // the fixture starts with refresh "off"; detection needs polling, so enabling turns it on
    await expect(page.locator('#interval')).toHaveValue('5000');
    await expect(page.locator('#notifyHint')).toContainText('30 s');
    await expect(page.locator('#notifySoundSwitch')).toBeEnabled();
    await expect(page.locator('#btnNotifyTest')).toBeEnabled();

    await page.locator('#btnNotifyTest').click();
    expect(await shown(page)).toEqual([{ title: 'Starlink: test notification', body: 'Notifications work. Keep this tab open.', sticky: false }]);

    await pick(page, 'notifyAfter', '60000');
    await page.locator('#notifySoundSwitch').click();
    await page.reload();
    await page.locator('#btnMenu').click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#notifyAfter')).toHaveValue('60000');
    await expect(page.locator('#notifySoundSwitch')).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#notifyHint')).toContainText('60 s');
  });

  test('a lasting outage fires once, recovery fires once, the tab title carries a ⚠ in between', async ({ page }) => {
    await fakeNotifications(page);
    await installClock(page);
    const api = await mockApi(page);
    await page.addInitScript(() => localStorage.setItem('sld.notify', '1'));
    await page.goto('/');
    await expect(page.locator('#connState')).toHaveText('Connected');
    await freezeClock(page);
    const title = await page.title();

    api.override('status', bad('OBSTRUCTED'));
    await poll(page);                         // 1st bad poll: starts the streak, nothing yet
    await pollAfter(page, 15000);             // 15 s: below the 30 s threshold
    expect(await shown(page)).toEqual([]);
    await expect(page).toHaveTitle(title);

    await pollAfter(page, 16000);             // 31 s of no connection → one "lost"
    expect(await shown(page)).toEqual([{ title: 'Starlink: connection lost', body: 'Obstructed · since 12:00:00 PM', sticky: true }]);
    await expect(page).toHaveTitle(`⚠ ${title}`);
    await expect(page.locator('.toast.bad')).toContainText('connection lost');

    api.override('status', bad('SEARCHING'));
    await pollAfter(page, 60000);             // still down: no second notification, cause stays the first one
    expect(await shown(page)).toHaveLength(1);

    api.override('status', undefined);        // back to the healthy mock
    await poll(page);                         // 1st good poll: not yet
    await pollAfter(page, 5000);              // 5 s of good polls: below the 10 s recovery delay
    expect(await shown(page)).toHaveLength(1);
    await expect(page).toHaveTitle(`⚠ ${title}`);

    await pollAfter(page, 6000);              // 11 s stable → one "restored"
    const all = await shown(page);
    expect(all).toHaveLength(2);
    expect(all[1]).toEqual({ title: 'Starlink: connection restored', body: 'Was down for 1m 31s · Obstructed', sticky: false });
    await expect(page).toHaveTitle(title);
    await expect(page.locator('.toast.ok')).toContainText('connection restored');
  });

  test('a short blip and an unreachable dish are handled: blips are ignored, unreachable counts as an outage', async ({ page }) => {
    await fakeNotifications(page);
    await installClock(page);
    const api = await mockApi(page);
    await page.addInitScript(() => { localStorage.setItem('sld.notify', '1'); localStorage.setItem('sld.notifyAfter', '10000'); });
    await page.goto('/');
    await expect(page.locator('#connState')).toHaveText('Connected');
    await freezeClock(page);

    // 8 s blip: bad, bad, then good again before the 10 s threshold
    api.override('status', bad('NO_DOWNLINK'));
    await poll(page); await pollAfter(page, 8000);
    api.override('status', undefined);
    await pollAfter(page, 2000);
    await pollAfter(page, 30000);
    expect(await shown(page)).toEqual([]);

    // the proxy cannot reach the dish at all
    api.override('status', { ok: false, error: 'Dish unreachable', hint: 'Are you on the Starlink network?' });
    await poll(page); await pollAfter(page, 12000);
    expect(await shown(page)).toEqual([{ title: 'Starlink: connection lost', body: 'unreachable · since 12:00:40 PM', sticky: true }]);
    await expect(page.locator('#banner')).toContainText('Dish unreachable');
  });

  test('nothing fires while the switch is off, and the texts follow the language', async ({ page }) => {
    await fakeNotifications(page);
    await installClock(page);
    const api = await mockApi(page);
    await page.goto('/');
    await expect(page.locator('#connState')).toHaveText('Connected');
    await freezeClock(page);
    api.override('status', bad('OBSTRUCTED'));
    await poll(page); await pollAfter(page, 60000); await pollAfter(page, 60000);
    expect(await shown(page)).toEqual([]);
    await expect(page).toHaveTitle('Starlink Local Debug');

    await pick(page, 'lang', 'uk');
    await page.locator('#btnMenu').click();
    await expect(page.locator('#notifyLabel')).toHaveText('Сповіщати про збої');
    await page.locator('#notifySwitch').click();
    await expect(page.locator('#notifyHint')).toContainText('30 с');
    await page.locator('#btnNotifyTest').click();
    expect((await shown(page))[0].title).toBe('Starlink: тестове сповіщення');
  });
});
