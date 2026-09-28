#!/usr/bin/env php
<?php
/**
 * Test double for grpcurl. api.php runs it exactly like the real binary.
 *
 * Behaviour comes from the JSON file named in $FAKE_GRPCURL_SCENARIO:
 * {
 *   "log": "/path/calls.jsonl",                // every invocation's argv is appended here
 *   "hosts": {
 *     "127.0.0.1:1": {
 *       "fields":    ["get_status", ...],      // request names reported by `describe`; null = describe fails
 *       "responses": { "get_status": {...} },  // JSON printed for a request
 *       "errors":    { "get_history": "..." }  // stderr text + exit 1 for a request
 *     }
 *   }
 * }
 * Anything not listed fails like grpcurl does for an unknown request name.
 */
declare(strict_types=1);

$argv = $_SERVER['argv'];
array_shift($argv);

// Decode as objects so an empty reply stays {} (like the real dish), not [].
$scenario = json_decode((string) @file_get_contents((string) getenv('FAKE_GRPCURL_SCENARIO'))) ?: new stdClass();
if (!empty($scenario->log)) {
    file_put_contents($scenario->log, json_encode($argv) . "\n", FILE_APPEND);
}

if (in_array('-version', $argv, true)) {
    fwrite(STDOUT, "grpcurl fake-1.0\n");
    exit(0);
}

// Find host (first "host:port" looking argument) and the -d payload.
$host = null;
$data = null;
for ($i = 0; $i < count($argv); $i++) {
    if ($argv[$i] === '-d') { $data = $argv[++$i] ?? null; continue; }
    if (in_array($argv[$i], ['-connect-timeout', '-max-time'], true)) { $i++; continue; }
    if ($host === null && preg_match('/^[\w.\-]+:\d+$/', $argv[$i])) { $host = $argv[$i]; }
}
$dev = $scenario->hosts->{$host} ?? null;
if ($dev === null) {
    fwrite(STDERR, "Failed to dial target host \"$host\": context deadline exceeded\n");
    exit(1);
}

if (in_array('describe', $argv, true)) {
    if (!isset($dev->fields)) {
        fwrite(STDERR, "Failed to resolve symbol \"SpaceX.API.Device.Request\": server does not support the reflection API\n");
        exit(1);
    }
    $out = "SpaceX.API.Device.Request is a message:\nmessage Request {\n  uint64 id = 1;\n  uint64 epoch_id = 14;\n  string target_id = 13;\n  oneof request {\n";
    $n = 1000;
    foreach ($dev->fields as $f) {
        $type = str_replace(' ', '', ucwords(str_replace('_', ' ', $f))) . 'Request';
        $out .= "    .SpaceX.API.Device.$type $f = " . ($n++) . ";\n";
    }
    fwrite(STDOUT, $out . "  }\n}\n");
    exit(0);
}

$req = json_decode((string) $data, true);
$name = is_array($req) ? (string) array_key_first($req) : '';
if (isset($dev->errors->{$name})) {
    fwrite(STDERR, $dev->errors->{$name} . "\n");
    exit(1);
}
if (isset($dev->responses) && property_exists($dev->responses, $name)) {
    fwrite(STDOUT, json_encode($dev->responses->{$name}, JSON_PRETTY_PRINT) . "\n");
    exit(0);
}
fwrite(STDERR, "Error invoking method \"SpaceX.API.Device.Device/Handle\": error getting request data: "
    . "message type SpaceX.API.Device.Request has no known field named $name\n");
exit(1);
