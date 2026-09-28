<?php
/**
 * Router for PHP's built-in server during tests.
 * Lets a test pretend to be another client address (X-Test-Remote-Addr) so the
 * local-only check in api.php can be exercised; otherwise serves files as usual.
 */
if (isset($_SERVER['HTTP_X_TEST_REMOTE_ADDR'])) {
    $_SERVER['REMOTE_ADDR'] = $_SERVER['HTTP_X_TEST_REMOTE_ADDR'];
}
if (parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) === '/api.php') {
    require __DIR__ . '/api.php';
    return true;
}
return false;
