# Patronus

A persistent personal web reader living on Alpha. Patronus retrieves rendered pages,
images, and direct downloads using preconfigured browser sessions. Jobs survive
client disconnection and never pause to request credentials.

Connect directly using **https://mcp.jensenabler.com/patronus/mcp** with OAuth.
Patronus owns its OAuth issuer, signing keys, consent, refresh tokens, and service.
Praxis is a development tool and optional compatibility client, not a runtime dependency.

## Development

Node >=22.22.0. Run `npm ci`, then `npm test`.
`npm start` starts the authenticated MCP gateway; `npm run reader` starts the
private Unix-socket worker. See [deployment](docs/deployment.md) and
[reader behavior and evidence](docs/reader.md). Optional [SolveCaptcha](docs/solvecaptcha.md)
supports reCAPTCHA v2 and standalone Turnstile during browser retrieval and X10 login.

Tools: patronus_capabilities, patronus_start, patronus_status, patronus_jobs,
patronus_result, patronus_artifact, and patronus_cancel. OAuth scope
`patronus:read` authorizes these retrieval and job-management operations, including
downloads and cancellation. It does not authorize arbitrary execution or posting.

Browser sandboxing, public-address-only networking, GET/HEAD policy, bounded
retrieval, and private artifacts remain enforced. Downloads from Mega need an
adapter; direct HTTP files work. Website access is not guaranteed.

## Provenance

Extracted from [JensenAbler/Praxis at ef0dfc0](https://github.com/JensenAbler/Praxis/tree/ef0dfc041896f75f2759900357673264792e8565).
Earlier history remains there. The OAuth implementation was adapted from the same
source with Patronus-specific scopes, branding, and independent state. This
repository contains source only, never browser profiles, OAuth credentials, or
retrieved private content.


X10 login diagnostics can be requested with `screenshots:true`; stage images mask
all input and textarea values and are retained as authenticated job artifacts.
`headed:true` runs the same Chromium and login policy on the service's local Xvfb
display. The installer requires `xvfb` and `xauth`; no remote viewer is exposed.
Computer-use login can use `timeoutSeconds:900` for up to fifteen minutes of
screenshot inspection and native input. Its status records the absolute `deadlineAt`,
and action receipts include `remainingSeconds`; the deadline never renews and
expired actions never replay. Programmatic login remains capped at five minutes.
Headless remains the default. X10's explicit server cooldown rejects fresh login
jobs while allowing existing-key recovery and credential-free session checks.

Both `patronus_start` and `patronus_login` accept `browser:"firefox"` (default
`chromium`). `patronus_start` also accepts `headed:true`, which renders on the same
service-local Xvfb display. Firefox keeps its own persistent profiles under
`firefox-profiles/<name>`; Chromium sessions are not shared with it, though a
provisioned `profiles/<name>/access.json` imports into either. The same proxy,
request policy and byte budget apply; Firefox gets equivalent prefs for QUIC,
WebRTC, DoH and background services. Its content sandbox needs the installer's
exact-path AppArmor userns grant to keep PID/user namespaces.
