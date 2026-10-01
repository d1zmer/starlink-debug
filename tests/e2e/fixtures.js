// Shared test helpers: a mock dish/router behind page.route('**/api.php*').
const { test: base, expect } = require('@playwright/test');

function makeStatus(dev) {
  return { dishGetStatus: {
    deviceInfo: { id: 'ut00000000-00000000-00example', hardwareVersion: 'rev3_proto2', softwareVersion: '2026.09.1', countryCode: 'UA', bootcount: 42 },
    deviceState: { uptimeS: '183245' },
    downlinkThroughputBps: 142_600_000, uplinkThroughputBps: 18_300_000, popPingLatencyMs: 31.4, popPingDropRate: 0.002, ethSpeedMbps: 1000,
    obstructionStats: { fractionObstructed: 0.0031, validS: 43200, avgProlongedObstructionIntervalS: 900 },
    // grpcurl omits false booleans, so flags only appear when true
    gpsStats: { gpsValid: true, gpsSats: 14, ...(dev.inhibitGps ? { inhibitGps: true } : {}) },
    ...(dev.stowed ? { stowRequested: true } : {}),
    hasActuators: dev.hasActuators,
    classOfService: 'CONSUMER', mobilityClass: 'STATIONARY', softwareUpdateState: 'IDLE', disablementCode: 'OKAY',
    alerts: { thermalThrottle: true, roaming: false },
    readyStates: { cady: false, scp: true, l1l2: true, xphy: true, aap: true, rf: true },
    alignmentStats: { tiltAngleDeg: 2, boresightAzimuthDeg: 87.8, attitudeEstimationState: 'FILTER_CONVERGED' },
    initializationDurationSeconds: { firstPopPing: 90, stableConnection: 120 },
  } };
}

function makeHistory(n = 300) {
  const a = f => Array.from({ length: n }, (_, i) => f(i));
  return { dishGetHistory: { current: String(n), downlinkThroughputBps: a(i => 8e7 + 1e6 * (i % 7)), uplinkThroughputBps: a(() => 1e7),
    popPingLatencyMs: a(i => 30 + (i % 5)), popPingDropRate: a(i => (i % 50 === 0 ? 1 : 0)), powerIn: a(() => 55), outages: [],
    _meta: { current: n, bufferSize: n, validSamples: n, returned: n } } };
}

function makeObstructionMap(frame = 'FRAME_EARTH') {
  const N = 41, snr = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const d = Math.hypot(c + 0.5 - N / 2, r + 0.5 - N / 2) / (N / 2);
    snr.push(d > 1 ? -1 : (c > 26 && r < 14 ? 0.1 : 0.95));      // obstruction in the north-east
  }
  return { dishGetObstructionMap: { numRows: N, numCols: N, snr, minElevationDeg: 25, maxThetaDeg: 65, mapReferenceFrame: frame } };
}

/**
 * Mock api.php. The "dish" reacts to actions: gps_off sets inhibitGps, stow sets stowRequested, etc.
 * Returns { dev, posts, requests, override } — override(cmd, response|fn) replaces a reply.
 */
async function mockApi(page, opts = {}) {
  const dev = { inhibitGps: false, stowed: false, hasActuators: 'HAS_ACTUATORS_YES', obstructionFrame: 'FRAME_EARTH', ...opts.dev };
  const posts = [], requests = [], overrides = {};
  const replies = {
    status: () => makeStatus(dev),
    history: () => makeHistory(),
    obstruction_map: () => makeObstructionMap(dev.obstructionFrame),
    dish_context: () => ({ dishGetContext: { cellId: 1234, polPopId: 17 } }),
    device_info: () => ({}),
    router_status: () => ({ getStatus: { deviceInfo: { id: 'Router-01', softwareVersion: '2026.09' }, isAviation: false } }),
    router_clients: () => ({ wifiGetClients: { clients: [{ name: 'MacBook', ipAddress: '192.168.1.20', macAddress: 'aa:bb:cc:dd:ee:ff', signalStrength: -51 }] } }),
    router_info: () => ({ getDeviceInfo: { deviceInfo: { id: 'Router-01', hardwareVersion: 'v4' } } }),
    probe: () => ({ php: '8.3.0', grpcurl: { path: '/opt/homebrew/bin/grpcurl', version: 'grpcurl 1.9.1' },
      dish: { host: '192.168.100.1:9200', tcp: { ok: true, ms: 3 } }, router: { host: '192.168.1.1:9000', tcp: { ok: true, ms: 2 } },
      internet: { tcp: { ok: true, ms: 30 }, dns: true }, server_time: '2026-09-28T12:00:00Z' }),
  };
  const actions = { gps_off: () => (dev.inhibitGps = true), gps_on: () => (dev.inhibitGps = false), stow: () => (dev.stowed = true), unstow: () => (dev.stowed = false) };
  await page.route('**/api.php*', async route => {
    const url = new URL(route.request().url());
    const cmd = url.searchParams.get('cmd');
    const method = route.request().method();
    requests.push(cmd);
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (overrides[cmd]) { const o = overrides[cmd]; return json(typeof o === 'function' ? o(route) : o); }
    if (method === 'POST') {
      const body = route.request().postData();
      posts.push({ cmd, body: body ? JSON.parse(body) : null });
      if (cmd === 'raw') return json({ ok: true, data: { echoed: JSON.parse(body).request }, target: 'dish', ms: 4 });
      actions[cmd]?.();
      return json({ ok: true, data: {}, ms: 20 });
    }
    if (cmd === 'fields') {
      const t = url.searchParams.get('target');
      return json({ ok: true, data: { fields: t === 'router' ? ['get_device_info', 'get_status', 'reboot', 'wifi_get_clients'] : ['dish_get_obstruction_map', 'get_history', 'get_status', 'reboot'] } });
    }
    if (replies[cmd]) return json({ ok: true, data: replies[cmd](), ms: 5 });
    return json({ ok: false, error: `not mocked: ${cmd}` });
  });
  return { dev, posts, requests, override: (cmd, v) => { overrides[cmd] = v; } };
}

/**
 * Mock Cloudflare's speed-test endpoints for the client → Internet test.
 * `__down?bytes=N` answers with N bytes, `__up` swallows the upload. Returns hit counters.
 */
async function mockSpeedServer(page, { fail = false } = {}) {
  const hits = { ping: 0, down: 0, up: 0 };
  await page.route('https://speed.cloudflare.com/**', async route => {
    if (fail) return route.abort('failed');
    const url = new URL(route.request().url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'server-timing' };
    if (url.pathname === '/__up') { hits.up++; return route.fulfill({ status: 200, headers: cors, body: 'ok' }); }
    const n = Number(url.searchParams.get('bytes') || 0);
    if (n === 0) hits.ping++; else hits.down++;
    return route.fulfill({ status: 200, headers: { ...cors, 'server-timing': 'cfRequestDuration;dur=0.4', 'content-type': 'application/octet-stream' }, body: Buffer.alloc(n, 48) });
  });
  return hits;
}
/** Shorten the browser-side test so it finishes in about two seconds. */
async function quickSpeedtest(page, extra = {}) {
  await page.evaluate(o => Object.assign(window.SLD_SPEEDTEST, o), { pings: 4, warmupPings: 1, downSeconds: 0.8, upSeconds: 0.8, downBytes: 200_000, upBytes: 100_000, warmupMs: 200, tickMs: 100, ...extra });
}

/** Change a header-menu <select> (they live inside the ☰ menu). */
async function pick(page, id, value) {
  await page.evaluate(([i, v]) => { const s = document.getElementById(i); s.value = v; s.dispatchEvent(new Event('change')); }, [id, value]);
}

const test = base.extend({
  // Start every test with auto-refresh off so timers don't interfere.
  page: async ({ page }, use) => {
    await page.addInitScript(() => { try { if (localStorage.getItem('sld.interval') === null) localStorage.setItem('sld.interval', '0'); } catch (e) {} });
    await use(page);
  },
});

module.exports = { test, expect, mockApi, mockSpeedServer, quickSpeedtest, pick, makeStatus };
