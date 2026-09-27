<?php
/**
 * Starlink Local Debug — configuration.
 *
 * Copy any key you want to override into local.config.php (same folder);
 * that file is optional and is merged on top of this one.
 */
return [
    // The dish. Every Starlink dish answers gRPC on this fixed address.
    'dish'   => '192.168.100.1:9200',

    // The Starlink Wi-Fi router (Gen 2 / Gen 3). Not reachable in Bypass Mode.
    'router' => '192.168.1.1:9000',

    // Path to the grpcurl binary. null = auto-detect:
    //   ./bin/grpcurl, /opt/homebrew/bin, /usr/local/bin, then $PATH.
    'grpcurl' => null,

    // Seconds to wait for a TCP connection / for a complete reply.
    'connect_timeout' => 3,
    'max_time'        => 12,

    // Only allow requests from this machine / the LAN. Leave true unless you
    // know what you are doing — the actions here can reboot your uplink.
    'local_only' => true,
];
