<?php
/**
 * Tests for api.php — no Composer, no network, no Starlink hardware needed.
 *
 *   php tests/php/run.php            run everything
 *   php tests/php/run.php history    run tests whose name contains "history"
 *
 * Each run copies api.php + config.php into a temp directory, points grpcurl at
 * tests/php/fake-grpcurl.php, starts PHP's built-in server and talks to it over HTTP.
 */
declare(strict_types=1);

const ROOT = __DIR__ . '/../..';
const DISH = '127.0.0.1:1';      // port 1/2: nothing listens, so TCP probes fail fast
const ROUTER = '127.0.0.1:2';

// ---------------------------------------------------------------- tiny test harness
$tests = [];
function test(string $name, callable $fn): void { global $tests; $tests[$name] = $fn; }
final class Fail extends Exception {}
function ok(bool $cond, string $msg = 'expected true'): void { if (!$cond) throw new Fail($msg); }
function same(mixed $expected, mixed $actual, string $msg = ''): void {
    if ($expected !== $actual) {
        throw new Fail(($msg ? "$msg: " : '') . 'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
    }
}
function contains(string $needle, ?string $hay, string $msg = ''): void {
    if ($hay === null || !str_contains($hay, $needle)) throw new Fail(($msg ? "$msg: " : '') . "expected to find \"$needle\" in " . var_export($hay, true));
}

// ---------------------------------------------------------------- sandbox + server
$work = sys_get_temp_dir() . '/sld-test-' . bin2hex(random_bytes(4));
$cache = "$work/tmp";
mkdir($cache, 0777, true);
copy(ROOT . '/api.php', "$work/api.php");
copy(ROOT . '/config.php', "$work/config.php");
copy(__DIR__ . '/router.php', "$work/router.php");
$fake = "$work/fake-grpcurl";
copy(__DIR__ . '/fake-grpcurl.php', $fake);
chmod($fake, 0755);
file_put_contents("$work/local.config.php", '<?php return ' . var_export([
    'dish' => DISH, 'router' => ROUTER, 'grpcurl' => $fake, 'connect_timeout' => 1, 'max_time' => 5,
], true) . ';');
$scenarioFile = "$work/scenario.json";
$logFile = "$work/calls.jsonl";

/** Replace what the fake dish/router answer. */
function scenario(array $hosts): void {
    global $scenarioFile, $logFile, $cache;
    file_put_contents($scenarioFile, json_encode(['log' => $logFile, 'hosts' => $hosts]));
    @unlink($logFile);
    foreach (glob("$cache/starlink-debug-fields-*.json") ?: [] as $f) unlink($f);   // reflection cache
}
/** argv of every grpcurl invocation since the last scenario() call. */
function calls(): array {
    global $logFile;
    return is_file($logFile) ? array_map(fn($l) => json_decode($l, true), file($logFile, FILE_IGNORE_NEW_LINES)) : [];
}
function requestCalls(): array {   // only the actual -d requests, not describe/-version
    return array_values(array_filter(calls(), fn($a) => in_array('-d', $a, true)));
}
function payloadOf(array $argv): ?string { $i = array_search('-d', $argv, true); return $i === false ? null : $argv[$i + 1]; }

$sock = stream_socket_server('tcp://127.0.0.1:0');
$port = (int) substr(strrchr(stream_socket_get_name($sock, false), ':'), 1);
fclose($sock);
define('BASE', "http://127.0.0.1:$port");
$env = array_merge(getenv(), ['FAKE_GRPCURL_SCENARIO' => $scenarioFile, 'TMPDIR' => $cache]);
$server = proc_open([PHP_BINARY, '-S', "127.0.0.1:$port", "$work/router.php"], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, $work, $env);
for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port); $i++) usleep(100_000);

function http(string $method, string $path, array $headers = [], ?string $body = null): array {
    $h = [];
    foreach ($headers as $k => $v) $h[] = "$k: $v";
    $ctx = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $h), 'content' => $body ?? '',
        'ignore_errors' => true, 'timeout' => 30]]);
    $raw = @file_get_contents(BASE . $path, false, $ctx);
    preg_match('#^HTTP/\S+\s+(\d+)#', $http_response_header[0] ?? '', $m);
    return ['status' => (int) ($m[1] ?? 0), 'json' => json_decode((string) $raw, true), 'raw' => $raw, 'headers' => $http_response_header ?? []];
}
function get(string $cmd, array $headers = []): array { return http('GET', "/api.php?cmd=$cmd", $headers); }
function post(string $cmd, ?array $body = null, bool $withHeader = true): array {
    $h = ['Content-Type' => 'application/json'];
    if ($withHeader) $h['X-Starlink-Debug'] = '1';
    return http('POST', "/api.php?cmd=$cmd", $h, $body === null ? null : json_encode($body));
}

$dishStatus = ['dishGetStatus' => ['deviceInfo' => ['id' => 'ut-test', 'softwareVersion' => '2026.09.1'], 'popPingLatencyMs' => 31.5]];

// ================================================================= tests
test('status: returns the dish reply and echoes the request', function () use ($dishStatus) {
    scenario([DISH => ['fields' => ['get_status'], 'responses' => ['get_status' => $dishStatus]]]);
    $r = get('status');
    same(200, $r['status']);
    same(true, $r['json']['ok']);
    same('ut-test', $r['json']['data']['dishGetStatus']['deviceInfo']['id']);
    same(['get_status' => []], $r['json']['request']);
    same(DISH, $r['json']['target']);
    same('{"get_status":{}}', payloadOf(requestCalls()[0]));
});

test('status: JSON is sent with no-store caching and nosniff', function () use ($dishStatus) {
    scenario([DISH => ['responses' => ['get_status' => $dishStatus]]]);
    $h = implode("\n", get('status')['headers']);
    contains('application/json', $h);
    contains('no-store', $h);
    contains('nosniff', $h);
});

test('unknown command: 400 with the list of commands', function () {
    scenario([]);
    $r = get('does_not_exist');
    same(400, $r['status']);
    same(false, $r['json']['ok']);
    ok(in_array('status', $r['json']['commands'], true), 'commands list includes status');
    same([], calls(), 'grpcurl must not run');
});

test('device actions: GET is refused and never reaches the device', function () {
    scenario([DISH => ['responses' => ['reboot' => new stdClass()]]]);
    foreach (['reboot', 'stow', 'unstow', 'gps_on', 'gps_off', 'router_reboot'] as $cmd) {
        same(405, get($cmd)['status'], "$cmd via GET");
    }
    same([], calls());
});

test('device actions: POST without the X-Starlink-Debug header is refused', function () {
    scenario([DISH => ['responses' => ['reboot' => new stdClass()]]]);
    same(405, post('reboot', null, false)['status']);
    same([], calls());
});

test('device actions: POST with header sends the right request', function () {
    scenario([DISH => ['responses' => ['reboot' => new stdClass(), 'dish_stow' => new stdClass(), 'dish_inhibit_gps' => new stdClass()]]]);
    $expect = ['reboot' => '{"reboot":{}}', 'stow' => '{"dish_stow":{}}', 'unstow' => '{"dish_stow":{"unstow":true}}',
               'gps_on' => '{"dish_inhibit_gps":{"inhibit_gps":false}}', 'gps_off' => '{"dish_inhibit_gps":{"inhibit_gps":true}}'];
    foreach ($expect as $cmd => $payload) {
        $r = post($cmd);
        same(true, $r['json']['ok'], "$cmd ok");
    }
    same(array_values($expect), array_map('payloadOf', requestCalls()));
});

test('raw: requires POST + header', function () {
    scenario([DISH => ['responses' => ['get_status' => []]]]);
    same(405, http('GET', '/api.php?cmd=raw')['status']);
    same(405, post('raw', ['target' => 'dish', 'request' => ['get_status' => new stdClass()]], false)['status']);
    same([], calls());
});

test('raw: rejects bodies that are not {"target","request":{…}}', function () {
    scenario([]);
    foreach ([null, ['target' => 'dish'], ['target' => 'dish', 'request' => 'get_status'], ['request' => [1, 2]]] as $body) {
        same(400, post('raw', $body)['status'], json_encode($body));
    }
    same(400, http('POST', '/api.php?cmd=raw', ['X-Starlink-Debug' => '1'], '{not json')['status']);
    same([], calls());
});

test('raw: forwards the request to the chosen target', function () {
    scenario([ROUTER => ['responses' => ['wifi_get_clients' => ['wifiGetClients' => ['clients' => []]]]]]);
    $r = post('raw', ['target' => 'router', 'request' => ['wifi_get_clients' => new stdClass()]]);
    same(true, $r['json']['ok']);
    same(ROUTER, $r['json']['target']);
    same('{"wifi_get_clients":{}}', payloadOf(requestCalls()[0]));
});

test('raw: unknown target falls back to the dish', function () use ($dishStatus) {
    scenario([DISH => ['responses' => ['get_status' => $dishStatus]]]);
    $r = post('raw', ['target' => 'evil-host:22', 'request' => ['get_status' => new stdClass()]]);
    same(DISH, $r['json']['target']);
});

test('raw: shell metacharacters are passed through as data, never executed', function () {
    global $work;
    $marker = "$work/pwned";
    scenario([DISH => ['fields' => ['get_status']]]);
    $evil = "get_status\"; touch $marker; echo \"";
    $r = post('raw', ['target' => 'dish', 'request' => [$evil => new stdClass(), 'x' => '$(touch ' . $marker . ')']]);
    same(false, $r['json']['ok'], 'fake device rejects the odd name');
    ok(!file_exists($marker), 'no shell command was executed');
    $argv = requestCalls()[0];
    same(json_decode(payloadOf($argv), true), [$evil => [], 'x' => '$(touch ' . $marker . ')'], 'payload is one intact argument');
});

test('history: ring buffer is returned in chronological order', function () {
    // 1000-slot buffer, 1003 samples written: slot p holds sample (p < 3 ? 1000 + p : p)
    $buf = [];
    for ($p = 0; $p < 1000; $p++) $buf[] = $p < 3 ? 1000 + $p : $p;
    scenario([DISH => ['responses' => ['get_history' => ['dishGetHistory' => ['current' => '1003', 'popPingLatencyMs' => $buf, 'outages' => [['cause' => 'NO_SCHEDULE']]]]]]]);
    $h = http('GET', '/api.php?cmd=history&samples=0')['json']['data']['dishGetHistory'];
    same(range(3, 1002), $h['popPingLatencyMs']);
    same(['current' => 1003, 'bufferSize' => 1000, 'validSamples' => 1000, 'returned' => 1000, 'sampleIntervalS' => 1], $h['_meta']);
    same([['cause' => 'NO_SCHEDULE']], $h['outages'], 'arrays of objects are left alone');
});

test('history: ?samples=N keeps only the newest N', function () {
    $buf = [];
    for ($p = 0; $p < 1000; $p++) $buf[] = $p < 3 ? 1000 + $p : $p;
    scenario([DISH => ['responses' => ['get_history' => ['dishGetHistory' => ['current' => '1003', 'popPingLatencyMs' => $buf]]]]]);
    $h = http('GET', '/api.php?cmd=history&samples=5')['json']['data']['dishGetHistory'];
    same([998, 999, 1000, 1001, 1002], $h['popPingLatencyMs']);
    same(5, $h['_meta']['returned']);
});

test('history: a buffer that is not full yet only returns written samples', function () {
    scenario([DISH => ['responses' => ['get_history' => ['dishGetHistory' => ['current' => '4', 'downlinkThroughputBps' => [10, 20, 30, 40, 0, 0, 0, 0, 0, 0]]]]]]);
    $h = get('history')['json']['data']['dishGetHistory'];
    same([10, 20, 30, 40], $h['downlinkThroughputBps']);
    same(4, $h['_meta']['validSamples']);
});

test('request discovery: uses the name the router actually supports', function () {
    scenario([ROUTER => ['fields' => ['get_status', 'get_device_info'], 'responses' => ['get_status' => ['wifiGetStatus' => ['isAviation' => false]]]]]);
    $r = get('router_status');
    same(true, $r['json']['ok']);
    same('get_status', $r['json']['used']);
    same(['{"get_status":{}}'], array_map('payloadOf', requestCalls()), 'wifi_get_status is skipped without a call');
});

test('request discovery: old name still wins when the firmware has it', function () {
    scenario([ROUTER => ['fields' => ['wifi_get_status', 'get_status'], 'responses' => ['wifi_get_status' => ['wifiGetStatus' => []], 'get_status' => []]]]);
    same('wifi_get_status', get('router_status')['json']['used']);
});

test('request discovery: without reflection, falls back on "no known field" errors', function () {
    scenario([ROUTER => ['fields' => null, 'responses' => ['get_status' => ['wifiGetStatus' => []]]]]);
    $r = get('router_status');
    same(true, $r['json']['ok']);
    same('get_status', $r['json']['used']);
    same(['{"wifi_get_status":{}}', '{"get_status":{}}'], array_map('payloadOf', requestCalls()));
});

test('request discovery: a stale reflection cache is refreshed once', function () {
    global $cache;
    scenario([ROUTER => ['fields' => ['get_status'], 'responses' => ['get_status' => ['wifiGetStatus' => []]]]]);
    file_put_contents("$cache/starlink-debug-fields-" . md5(ROUTER) . '.json', json_encode(['wifi_get_clients']));
    $r = get('router_status');
    same('get_status', $r['json']['used']);
    ok(count(array_filter(calls(), fn($a) => in_array('describe', $a, true))) === 1, 'described once to refresh');
});

test('request discovery: reflection result is cached between calls', function () {
    scenario([ROUTER => ['fields' => ['get_status'], 'responses' => ['get_status' => ['wifiGetStatus' => []]]]]);
    get('router_status');
    get('router_status');
    same(1, count(array_filter(calls(), fn($a) => in_array('describe', $a, true))));
});

test('request discovery: clear error when nothing matches', function () {
    scenario([ROUTER => ['fields' => ['get_device_info', 'get_ping_status']]]);
    $r = get('router_diagnostics');
    same(false, $r['json']['ok']);
    contains('does not support wifi_get_diagnostics / get_diagnostics', $r['json']['error']);
    same([], requestCalls(), 'no blind requests are sent');
});

test('fields: lists request names sorted, without id/target_id/epoch_id', function () {
    scenario([ROUTER => ['fields' => ['wifi_get_clients', 'get_status', 'reboot']]]);
    $r = http('GET', '/api.php?cmd=fields&target=router');
    same(['get_status', 'reboot', 'wifi_get_clients'], $r['json']['data']['fields']);
});

test('fields: reports when the device cannot be asked', function () {
    scenario([DISH => ['fields' => null]]);
    $r = http('GET', '/api.php?cmd=fields&target=dish');
    same(false, $r['json']['ok']);
    contains('Could not read the request list', $r['json']['error']);
});

test('errors: unreachable dish gets a helpful hint', function () {
    scenario([]);   // unknown host → fake grpcurl reports "Failed to dial"
    $r = get('status');
    same(200, $r['status'], 'device errors are still a successful proxy round-trip');
    same(false, $r['json']['ok']);
    contains('Dish not reachable', $r['json']['hint']);
});

test('errors: unreachable router mentions Bypass Mode', function () {
    scenario([]);
    contains('Bypass Mode', get('router_info')['json']['hint']);
});

test('errors: unknown request name gets the spelling hint', function () {
    scenario([DISH => ['fields' => ['get_status']]]);
    $r = post('raw', ['target' => 'dish', 'request' => ['get_obstruction_map' => new stdClass()]]);
    contains('has no known field named get_obstruction_map', $r['json']['error']);
    contains('does not recognise that request name', $r['json']['hint']);
});

test('errors: permission denied mentions the location setting', function () {
    scenario([DISH => ['errors' => ['get_location' => 'ERROR: Code: PermissionDenied Message: not authorized']]]);
    contains('Location data must be enabled', get('location')['json']['hint']);
});

test('local-only: requests from public addresses are refused', function () use ($dishStatus) {
    scenario([DISH => ['responses' => ['get_status' => $dishStatus]]]);
    foreach (['8.8.8.8', '172.32.0.1', '2001:db8::1', '100.64.0.1'] as $ip) {
        same(403, get('status', ['X-Test-Remote-Addr' => $ip])['status'], $ip);
    }
    same([], calls());
});

test('local-only: localhost, private and link-local addresses are allowed', function () use ($dishStatus) {
    scenario([DISH => ['responses' => ['get_status' => $dishStatus]]]);
    foreach (['127.0.0.1', '::1', '192.168.1.20', '10.0.0.5', '172.16.4.4', '172.31.255.1', '169.254.3.3', 'fe80::1', 'fd00::5'] as $ip) {
        same(200, get('status', ['X-Test-Remote-Addr' => $ip])['status'], $ip);
    }
});

test('probe: reports grpcurl, PHP and reachability', function () {
    global $fake;
    scenario([]);
    $d = get('probe')['json']['data'];
    same($fake, $d['grpcurl']['path']);
    contains('fake-1.0', $d['grpcurl']['version']);
    same(PHP_VERSION, $d['php']);
    same(false, $d['dish']['tcp']['ok'], 'nothing listens on the test dish port');
    same(DISH, $d['dish']['host']);
});

// ================================================================= run
$filter = $argv[1] ?? '';
$passed = $failed = 0;
foreach ($tests as $name => $fn) {
    if ($filter !== '' && !str_contains($name, $filter)) continue;
    try { $fn(); $passed++; echo "  \033[32m✓\033[0m $name\n"; }
    catch (Throwable $e) { $failed++; echo "  \033[31m✗ $name\033[0m\n      " . $e->getMessage() . "\n"; }
}
proc_terminate($server);
proc_close($server);
exec('rm -rf ' . escapeshellarg($work));
echo "\n" . ($failed ? "\033[31m" : "\033[32m") . "$passed passed, $failed failed\033[0m\n";
exit($failed ? 1 : 0);
