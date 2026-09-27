# Security policy

Starlink Local Debug is meant to run on your own computer or home network. It can reboot,
stow and reconfigure a Starlink dish and router, so please:

- **Never expose it to the internet** (no port forwarding, no public reverse proxy).
- Keep `local_only` set to `true` in `config.php` (the default). `api.php` then rejects
  requests from anything other than localhost and private/link-local addresses.

## What the proxy guarantees

- Only a fixed set of named commands is executed; the Raw API endpoint accepts a JSON object,
  which is decoded and re-encoded before being passed to `grpcurl` as a single argument.
  User input is never interpolated into a shell command.
- Commands that change device state require `POST` plus the `X-Starlink-Debug: 1` header.
  Browsers only send that header cross-origin after a CORS preflight, which `api.php` never
  approves, so other websites cannot trigger actions.

## Reporting a vulnerability

Please report security issues privately via
**GitHub → Security → Report a vulnerability** on this repository rather than in a public issue.
Include steps to reproduce and the PHP / grpcurl versions you used.
