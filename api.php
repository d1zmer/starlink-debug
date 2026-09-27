<?php
/**
 * Starlink Local Debug — API proxy.
 *
 * Talks to the dish (192.168.100.1:9200) and the Starlink router
 * (192.168.1.1:9000) over their local gRPC interface using `grpcurl`,
 * and hands the JSON back to index.html.
 *
 *   GET  api.php?cmd=status
 *   GET  api.php?cmd=history&samples=900
 *   GET  api.php?cmd=probe
 *   POST api.php?cmd=reboot           (header X-Starlink-Debug: 1 required)
 *   POST api.php?cmd=raw              body: {"target":"dish","request":{"get_status":{}}}
 *
 * Nothing from the query string ever reaches the shell except a whitelisted
 * command key; the raw endpoint re-encodes validated JSON before use.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$config = require __DIR__ . '/config.php';
if (is_file(__DIR__ . '/local.config.php')) {
    $config = array_merge($config, require __DIR__ . '/local.config.php');
}

const GRPC_METHOD = 'SpaceX.API.Device.Device/Handle';

/**
 * key => [target, request, mutating?]
 * `request` is either a JSON string, or a list of candidate request names: Starlink renames
 * requests between firmware versions, so the proxy asks the device (via gRPC reflection) which
 * names it accepts and uses the first candidate that exists.
 */
$COMMANDS = [
    // --- dish: read-only ---
    'status'             => ['dish',   '{"get_status":{}}',             false],
    'history'            => ['dish',   '{"get_history":{}}',            false],
    'device_info'        => ['dish',   '{"get_device_info":{}}',        false],
    'diagnostics'        => ['dish',   '{"get_diagnostics":{}}',        false],
    'obstruction_map'    => ['dish',   ['dish_get_obstruction_map', 'get_obstruction_map'], false],
    'location'           => ['dish',   '{"get_location":{}}',           false],
    'dish_context'       => ['dish',   '{"dish_get_context":{}}',       false],
    'dish_config'        => ['dish',   '{"dish_get_config":{}}',        false],
    // --- dish: actions ---
    'reboot'             => ['dish',   '{"reboot":{}}',                              true],
    'stow'               => ['dish',   '{"dish_stow":{}}',                           true],
    'unstow'             => ['dish',   '{"dish_stow":{"unstow":true}}',              true],
    'gps_on'             => ['dish',   '{"dish_inhibit_gps":{"inhibit_gps":false}}', true],
    'gps_off'            => ['dish',   '{"dish_inhibit_gps":{"inhibit_gps":true}}',  true],
    // --- router ---
    'router_status'      => ['router', ['wifi_get_status', 'get_status'],           false],
    'router_clients'     => ['router', ['wifi_get_clients', 'get_clients'],         false],
    'router_diagnostics' => ['router', ['wifi_get_diagnostics', 'get_diagnostics'], false],
    'router_info'        => ['router', '{"get_device_info":{}}',        false],
    'router_reboot'      => ['router', '{"reboot":{}}',                 true],
];

// ---------------------------------------------------------------------------

function respond(array $payload, int $http = 200): never
{
    http_response_code($http);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
    exit;
}

function fail(string $error, int $http = 500, array $extra = []): never
{
    respond(['ok' => false, 'error' => $error] + $extra, $http);
}

function is_local_client(): bool
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    if ($ip === '' || $ip === '127.0.0.1' || $ip === '::1') {
        return true;
    }
    // RFC1918 + link-local: anything on the home network is fine.
    return (bool) preg_match(
        '/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fd)/i',
        $ip
    );
}

function find_grpcurl(array $config): ?string
{
    $candidates = [];
    if (!empty($config['grpcurl'])) {
        $candidates[] = $config['grpcurl'];
    }
    $candidates[] = __DIR__ . '/bin/grpcurl';
    $candidates[] = '/opt/homebrew/bin/grpcurl';   // Apple Silicon Homebrew
    $candidates[] = '/usr/local/bin/grpcurl';      // Intel Homebrew / manual
    foreach ($candidates as $c) {
        if (is_file($c) && is_executable($c)) {
            return $c;
        }
    }
    // MAMP's PHP usually has a very short PATH, so this is a last resort.
    $which = trim((string) shell_exec('command -v grpcurl 2>/dev/null'));
    return $which !== '' ? $which : null;
}

/**
 * Run grpcurl and return [exitCode, stdout, stderr].
 */
function run_process(array $argv, int $timeoutSec): array
{
    $cmd = implode(' ', array_map('escapeshellarg', $argv));
    $spec = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $proc = proc_open($cmd, $spec, $pipes);
    if (!is_resource($proc)) {
        return [-1, '', 'proc_open failed — is shell execution disabled in this PHP?'];
    }
    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);

    $out = '';
    $err = '';
    $deadline = microtime(true) + $timeoutSec + 2;
    while (true) {
        $out .= (string) stream_get_contents($pipes[1]);
        $err .= (string) stream_get_contents($pipes[2]);
        $st = proc_get_status($proc);
        if (!$st['running']) {
            $out .= (string) stream_get_contents($pipes[1]);
            $err .= (string) stream_get_contents($pipes[2]);
            $code = $st['exitcode'];
            break;
        }
        if (microtime(true) > $deadline) {
            proc_terminate($proc, 9);
            $code = 124;
            $err .= "\nTimed out after {$timeoutSec}s";
            break;
        }
        usleep(20000);
    }
    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($proc);
    return [$code, $out, $err];
}

function hint_for_error(string $target, string $err): string
{
    $e = strtolower($err);
    if (str_contains($e, 'failed to dial') || str_contains($e, 'timed out')
        || str_contains($e, 'connection refused') || str_contains($e, 'no route')) {
        if ($target === 'router') {
            return 'Router not reachable on 192.168.1.1:9000. If you use Bypass Mode or a '
                 . 'third-party router, the Starlink router is out of the path — that is expected.';
        }
        return 'Dish not reachable on 192.168.100.1:9200. Make sure this Mac is on the '
             . 'Starlink network (no VPN). In Bypass Mode with your own router, add a static '
             . 'route for 192.168.100.0/24 via the Starlink WAN interface.';
    }
    if (str_contains($e, 'permissiondenied') || str_contains($e, 'permission denied')) {
        return 'The dish refused this request. Location data must be enabled in the Starlink '
             . 'app (Advanced → Debug data → Starlink Location → allow access on local network), '
             . 'and on many current plans it is no longer exposed at all.';
    }
    if (str_contains($e, 'has no known field named')) {
        return 'The dish does not recognise that request name (grpcurl checks names against the '
             . 'schema the dish publishes via reflection). Check the spelling — e.g. the map is '
             . '"dish_get_obstruction_map", not "get_obstruction_map" — or this firmware dropped it.';
    }
    if (str_contains($e, 'unimplemented') || str_contains($e, 'unknown method')
        || str_contains($e, 'not found')) {
        return 'This firmware does not support that request.';
    }
    if (str_contains($e, 'reflection')) {
        return 'gRPC reflection failed — the device did not describe its API. Firmware may have changed.';
    }
    return '';
}

function grpc_call(array $config, string $target, string $requestJson): array
{
    $bin = find_grpcurl($config);
    if ($bin === null) {
        return [
            'ok'    => false,
            'error' => 'grpcurl is not installed (or not found).',
            'hint'  => 'Install it with Homebrew:  brew install grpcurl   — or put the binary in '
                     . __DIR__ . '/bin/grpcurl, or set "grpcurl" in config.php.',
        ];
    }
    $host = $config[$target] ?? null;
    if ($host === null) {
        return ['ok' => false, 'error' => "Unknown target '$target'"];
    }

    $argv = [
        $bin, '-plaintext',
        '-connect-timeout', (string) $config['connect_timeout'],
        '-max-time', (string) $config['max_time'],
        '-d', $requestJson,
        $host, GRPC_METHOD,
    ];
    $t0 = microtime(true);
    [$code, $out, $err] = run_process($argv, (int) $config['max_time']);
    $ms = (int) round((microtime(true) - $t0) * 1000);

    if ($code !== 0) {
        $msg = trim($err) !== '' ? trim($err) : "grpcurl exited with code $code";
        return [
            'ok'      => false,
            'error'   => $msg,
            'hint'    => hint_for_error($target, $msg),
            'target'  => $host,
            'ms'      => $ms,
            'request' => json_decode($requestJson),
        ];
    }
    // Decode to objects (not assoc arrays) so that empty {} survives re-encoding.
    $data = json_decode(trim($out), false);
    if (!is_object($data)) {
        return ['ok' => false, 'error' => 'Could not parse grpcurl output as JSON', 'raw' => $out, 'ms' => $ms];
    }
    return ['ok' => true, 'data' => $data, 'target' => $host, 'ms' => $ms, 'request' => json_decode($requestJson)];
}

/**
 * Request names the device accepts, read from its gRPC reflection schema
 * (`grpcurl describe SpaceX.API.Device.Request`). Cached for 10 minutes per device.
 * Returns null if the device could not be asked.
 */
function request_fields(array $config, string $target, bool $fresh = false): ?array
{
    $host = $config[$target] ?? null;
    $bin  = find_grpcurl($config);
    if ($host === null || $bin === null) {
        return null;
    }
    $cache = sys_get_temp_dir() . '/starlink-debug-fields-' . md5($host) . '.json';
    if (!$fresh && is_file($cache) && (time() - filemtime($cache)) < 600) {
        $cached = json_decode((string) file_get_contents($cache), true);
        if (is_array($cached) && $cached !== []) {
            return $cached;
        }
    }
    [$code, $out] = run_process([
        $bin, '-plaintext',
        '-connect-timeout', (string) $config['connect_timeout'],
        '-max-time', (string) $config['max_time'],
        $host, 'describe', 'SpaceX.API.Device.Request',
    ], (int) $config['max_time']);
    if ($code !== 0) {
        return null;
    }
    // Lines look like:  .SpaceX.API.Device.GetStatusRequest get_status = 1004;
    preg_match_all('/^\s*(?:\.[\w.]+\s+)(\w+)\s*=\s*\d+\s*;/m', $out, $m);
    $fields = array_values(array_unique(array_filter($m[1], fn($f) => $f !== 'id' && $f !== 'target_id' && $f !== 'epoch_id')));
    if ($fields !== []) {
        @file_put_contents($cache, json_encode($fields));
    }
    return $fields;
}

/** Call the first request name from $candidates that the device supports. */
function grpc_call_candidates(array $config, string $target, array $candidates): array
{
    $fields = request_fields($config, $target);
    $order  = $candidates;
    if (is_array($fields) && $fields !== []) {
        $order = array_values(array_filter($candidates, fn($c) => in_array($c, $fields, true)));
        if ($order === []) {
            // Schema may be stale (firmware just updated): re-read once before giving up.
            $fields = request_fields($config, $target, true) ?? [];
            $order  = array_values(array_filter($candidates, fn($c) => in_array($c, $fields, true)));
        }
        if ($order === []) {
            $words = array_unique(array_merge(...array_map(fn($c) => array_slice(explode('_', $c), -1), $candidates)));
            $similar = array_values(array_filter($fields, function ($f) use ($words) {
                foreach ($words as $w) { if (str_contains($f, $w)) return true; }
                return false;
            }));
            return [
                'ok'      => false,
                'error'   => "The $target does not support " . implode(' / ', $candidates) . ' on this firmware.',
                'hint'    => ($similar ? 'Related requests it does accept: ' . implode(', ', $similar) . '. ' : '')
                           . 'Open Raw API and pick the ' . $target . ' target to see every request it accepts.',
                'target'  => $config[$target] ?? $target,
                'tried'   => $candidates,
            ];
        }
    }
    $last = null;
    foreach ($order as $name) {
        $res = grpc_call($config, $target, json_encode([$name => new stdClass()]));
        $res['used'] = $name;
        if ($res['ok'] || !str_contains(strtolower((string) ($res['error'] ?? '')), 'has no known field named')) {
            return $res;
        }
        $last = $res;
    }
    return $last ?? ['ok' => false, 'error' => 'No request candidates'];
}

/**
 * The dish returns its history as ring buffers plus a running sample counter
 * (`current`). Turn every numeric array into chronological order and keep
 * only the last $samples entries so the browser gets a small, ready payload.
 */
function unwrap_history(object $data, int $samples): object
{
    $h = $data->dishGetHistory ?? null;
    if (!is_object($h)) {
        return $data;
    }
    $isSampleArray = static fn($v): bool => is_array($v) && $v !== [] && !is_object($v[0]) && !is_array($v[0]);
    $current = (int) ($h->current ?? 0);
    $bufferSize = 0;
    foreach (get_object_vars($h) as $k => $v) {
        if ($isSampleArray($v)) {
            $bufferSize = max($bufferSize, count($v));
        }
    }
    $valid = $bufferSize > 0 ? min($current, $bufferSize) : 0;
    $keep  = $samples > 0 ? min($samples, $valid) : $valid;

    foreach (get_object_vars($h) as $k => $v) {
        if (!$isSampleArray($v)) {
            continue; // skip scalars and arrays of objects (e.g. outages)
        }
        $n = count($v);
        if ($current >= $n) {
            $start = $current % $n;
            $ordered = array_merge(array_slice($v, $start), array_slice($v, 0, $start));
        } else {
            $ordered = array_slice($v, 0, $current);
        }
        $h->$k = $keep > 0 ? array_values(array_slice($ordered, -$keep)) : [];
    }
    $h->_meta = [
        'current'         => $current,
        'bufferSize'      => $bufferSize,
        'validSamples'    => $valid,
        'returned'        => $keep,
        'sampleIntervalS' => 1,
    ];
    return $data;
}

function tcp_probe(string $hostPort, float $timeout = 2.0): array
{
    [$host, $port] = array_pad(explode(':', $hostPort, 2), 2, '80');
    $t0 = microtime(true);
    $errno = 0; $errstr = '';
    $fp = @fsockopen($host, (int) $port, $errno, $errstr, $timeout);
    $ms = (int) round((microtime(true) - $t0) * 1000);
    if ($fp) {
        fclose($fp);
        return ['ok' => true, 'ms' => $ms];
    }
    return ['ok' => false, 'ms' => $ms, 'error' => $errstr !== '' ? $errstr : "errno $errno"];
}

// ---------------------------------------------------------------------------

if (!empty($config['local_only']) && !is_local_client()) {
    fail('Refusing request from a non-local address.', 403);
}

$cmd    = (string) ($_GET['cmd'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($cmd === 'probe') {
    $bin = find_grpcurl($config);
    $version = null;
    if ($bin !== null) {
        [, $vout, $verr] = run_process([$bin, '-version'], 5);
        $version = trim($vout . $verr);
    }
    $dns = @gethostbyname('www.starlink.com');
    respond([
        'ok' => true,
        'data' => [
            'php'      => PHP_VERSION,
            'grpcurl'  => ['path' => $bin, 'version' => $version],
            'dish'     => ['host' => $config['dish'],   'tcp' => tcp_probe($config['dish'])],
            'router'   => ['host' => $config['router'], 'tcp' => tcp_probe($config['router'])],
            'internet' => ['tcp' => tcp_probe('1.1.1.1:443'),
                           'dns' => ($dns !== 'www.starlink.com' && $dns !== false)],
            'server_time' => date('c'),
        ],
    ]);
}

if ($cmd === 'fields') {
    $target = ($_GET['target'] ?? 'dish') === 'router' ? 'router' : 'dish';
    $fields = request_fields($config, $target, !empty($_GET['fresh']));
    if ($fields === null) {
        fail("Could not read the request list from the $target (is it reachable?)", 200, ['target' => $config[$target]]);
    }
    sort($fields);
    respond(['ok' => true, 'data' => ['target' => $config[$target], 'fields' => $fields]]);
}

if ($cmd === 'raw') {
    if ($method !== 'POST' || ($_SERVER['HTTP_X_STARLINK_DEBUG'] ?? '') !== '1') {
        fail('raw requires POST with header X-Starlink-Debug: 1', 405);
    }
    // Decode to objects so an empty {} stays {} when re-encoded for grpcurl.
    $body = json_decode((string) file_get_contents('php://input'), false);
    if (!is_object($body) || !isset($body->request) || !is_object($body->request)) {
        fail('Body must be JSON: {"target":"dish"|"router","request":{...}}', 400);
    }
    $target = ($body->target ?? 'dish') === 'router' ? 'router' : 'dish';
    $reqJson = json_encode($body->request, JSON_UNESCAPED_SLASHES);
    respond(grpc_call($config, $target, $reqJson));
}

if (!isset($COMMANDS[$cmd])) {
    fail("Unknown command '$cmd'", 400, ['commands' => array_keys($COMMANDS)]);
}

[$target, $requestJson, $mutating] = $COMMANDS[$cmd];

if ($mutating) {
    if ($method !== 'POST' || ($_SERVER['HTTP_X_STARLINK_DEBUG'] ?? '') !== '1') {
        fail("'$cmd' changes device state: it requires POST with header X-Starlink-Debug: 1", 405);
    }
}

$result = is_array($requestJson)
    ? grpc_call_candidates($config, $target, $requestJson)
    : grpc_call($config, $target, $requestJson);

if ($result['ok'] && $cmd === 'history') {
    $samples = (int) ($_GET['samples'] ?? 900);
    $result['data'] = unwrap_history($result['data'], $samples);
}

// Device-level failures (unreachable, permission denied…) are still a
// successful proxy round-trip, so they go back as HTTP 200 with ok:false.
respond($result);
