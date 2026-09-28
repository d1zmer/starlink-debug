const { test, expect, mockApi, pick } = require('./fixtures');

const dialog = page => page.locator('#confirmDlg');

test.describe('confirmation dialog', () => {
  test('Reboot dish: Cancel (default focus), Esc and clicking outside send nothing', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/');
    const reboot = page.locator('[data-action="reboot"]');

    await reboot.click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('#dlgTitle')).toHaveText('Reboot the dish?');
    await expect(page.locator('#dlgCancel')).toBeFocused();
    await page.keyboard.press('Enter');                            // Enter on the focused Cancel
    await expect(dialog(page)).toBeHidden();

    await reboot.click();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();

    await reboot.click();
    await page.mouse.click(5, 5);                                  // backdrop
    await expect(dialog(page)).toBeHidden();

    expect(api.posts).toEqual([]);
  });

  test('Reboot dish: confirming sends exactly one POST', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/');
    await page.locator('[data-action="reboot"]').click();
    await page.locator('#dlgOk').click();
    await expect.poll(() => api.posts.map(p => p.cmd)).toEqual(['reboot']);
  });

  test('Reboot router asks with its own text', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/');
    await page.locator('[data-action="router_reboot"]').click();
    await expect(page.locator('#dlgTitle')).toHaveText('Reboot the router?');
    await page.locator('#dlgOk').click();
    await expect.poll(() => api.posts.map(p => p.cmd)).toEqual(['router_reboot']);
  });

  test('dialog is translated', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await pick(page, 'lang', 'de');
    await page.locator('[data-action="reboot"]').click();
    await expect(page.locator('#dlgTitle')).toHaveText('Antenne neu starten?');
    await expect(page.locator('#dlgCancel')).toHaveText('Abbrechen');
  });
});

test.describe('GPS switch', () => {
  test('mirrors the dish (inhibitGps) and toggles only after confirmation', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/');
    const sw = page.locator('#gpsSwitch');
    await expect(sw).toHaveAttribute('role', 'switch');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#gpsSwitchState')).toHaveText('On · 14 satellites');

    await sw.click();
    await expect(page.locator('#dlgTitle')).toHaveText('Turn GPS off?');
    await page.locator('#dlgCancel').click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(api.posts).toEqual([]);

    await sw.click();
    await page.locator('#dlgOk').click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#gpsSwitchState')).toHaveText('Off');
    expect(api.posts.map(p => p.cmd)).toEqual(['gps_off']);
    expect(api.dev.inhibitGps).toBe(true);
  });

  test('starts off when the dish reports inhibitGps', async ({ page }) => {
    await mockApi(page, { dev: { inhibitGps: true } });
    await page.goto('/');
    await expect(page.locator('#gpsSwitch')).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#gpsSwitchState')).toHaveText('Off');
  });

  test('Space toggles it from the keyboard', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/');
    await page.locator('#gpsSwitch').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#dlgTitle')).toHaveText('Turn GPS off?');
    await page.locator('#dlgOk').click();
    await expect.poll(() => api.posts.map(p => p.cmd)).toEqual(['gps_off']);
  });

  test('is disabled when the dish sends no GPS data', async ({ page }) => {
    const api = await mockApi(page);
    api.override('status', { ok: true, data: { dishGetStatus: { deviceInfo: {}, alerts: {} } } });
    await page.goto('/');
    await expect(page.locator('#gpsSwitch')).toBeDisabled();
    await expect(page.locator('#gpsSwitchState')).toHaveText('Status unknown');
  });
});

test.describe('Stow switch', () => {
  test('stow and unstow round-trip, with danger styling only for stow', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/');
    const sw = page.locator('#stowSwitch');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#stowSwitchState')).toHaveText('In working position');

    await sw.click();
    await expect(page.locator('#dlgOk')).toHaveClass(/danger-solid/);
    await page.locator('#dlgOk').click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#stowSwitchState')).toHaveText('Stowed');

    await sw.click();
    await expect(page.locator('#dlgTitle')).toHaveText('Unstow the dish?');
    await expect(page.locator('#dlgOk')).not.toHaveClass(/danger-solid/);
    await page.locator('#dlgOk').click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(api.posts.map(p => p.cmd)).toEqual(['stow', 'unstow']);
  });

  test('is locked on dishes without motors', async ({ page }) => {
    await mockApi(page, { dev: { hasActuators: 'HAS_ACTUATORS_NO' } });
    await page.goto('/');
    await expect(page.locator('#stowSwitch')).toBeDisabled();
    await expect(page.locator('#stowSwitchState')).toHaveText('Not available (no motors)');
  });

  test('shows Stowed when the dish is already stowed', async ({ page }) => {
    await mockApi(page, { dev: { stowed: true } });
    await page.goto('/');
    await expect(page.locator('#stowSwitch')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#connState')).toHaveText('Stowed');
  });
});
