# Phone-preferred upstream web egress

Set PATRONUS_EGRESS_PROXY=http://127.0.0.1:1056 in the reader service environment
to prefer the existing loopback HTTP CONNECT proxy for reader web traffic.
If that upstream is unavailable before origin dispatch, Patronus uses Alpha's
direct connection instead. Direct fallback exposes Alpha's public IP, not the
phone's. This optional setting is not enabled by installing source alone.
An unset or blank value keeps the prior direct default.

Only HTTP proxies on 127.0.0.1, ::1, or localhost with an explicit non-default port
are accepted. localhost is pinned to 127.0.0.1. Credentials, paths, query strings,
fragments, remote hosts, and HTTPS proxy URLs are rejected. An invalid nonempty
value fails before any destination request. The upstream is an operator-managed
local service; this setting does not select or configure a Tailscale exit node.

## Coverage and routing

- Ordinary reader HTTP and HTTPS requests, including each redirect and direct
  downloads, use the shared publicRequest transport.
- Browser proxy HTTP GET/HEAD and CONNECT tunnels use the default. This includes
  rendered retrievals, browser subresources, browser-login sessions, persistent
  desktop browsing, and WebSockets carried through CONNECT.
- Solver API submission and polling POSTs use the same transport. They have no
  redirect following or request retries, redact errors, preserve cancellation,
  and retain the 15-second request timeout and 64 KiB response cap.
- Desktop PATRONUS_EGRESS_ROUTES remains an optional per-domain override.
  A matching override selects that loopback proxy; all unmatched domains use
  PATRONUS_EGRESS_PROXY. Supplying routes, including an empty list, does not disable
  the default. Explicit routes use the same availability fallback to Alpha,
  not a second attempt through the default proxy. Desktop passes both settings
  from its environment.
- Without a default, existing per-domain desktop overrides still work and other
  traffic retains its prior direct behavior. Plain HTTP through an override is
  tunneled too rather than being rejected.

Each new request/tunnel tries its selected upstream again. There is no sticky
direct mode, circuit breaker, background reconnect, or replay of an established
connection when the phone recovers.

## Safe availability fallback

The initial CONNECT attempt has a total timeout of 5 seconds or the smaller
request timeout. Upstream TCP connection error/closure, CONNECT timeout, or
CONNECT status 502/503/504 can select a direct Alpha connection. This covers an
offline phone while the local Tailscale proxy still listens. At this point only
the validated destination IP/port has reached the proxy: no origin HTTP headers,
credentials, body, or browser tunnel bytes have been sent. The normal request
timeout starts on the selected connection; negotiation can add up to 5 seconds.

There is no fallback for proxy authentication/authorization denial (including
401/403/407), other non-200 status codes, malformed/incomplete/oversized proxy responses,
invalid configuration, destination DNS/SSRF policy failures, TLS/certificate
failures, destination HTTP responses (including 401/403/502/503), or cancellation.
These are terminal failures, not evidence that direct routing is appropriate.

Once origin dispatch begins, transport failure never selects another route or
resends the request. Write methods (anything except GET/HEAD/OPTIONS) report
REQUEST_OUTCOME_UNCERTAIN with outcomeUncertain=true when a transport failure
could hide an origin result; callers must reconcile rather than blindly retry.
Solver transport masks this as SOLVER_OUTCOME_UNCERTAIN without exposing secrets.
Cancellation retains its cancellation identity; cancelling after dispatch does
not undo a possible server-side effect.

Browser CONNECT chooses a route before returning 200 or releasing buffered tunnel
bytes. Once established, a broken tunnel closes without reconnecting or replaying.
Browser tunnels are opaque: Patronus cannot determine whether an encrypted write
was accepted, so the caller must reconcile an interrupted operation.

## Security and observability

Every hop resolves with Alpha's existing OS DNS resolver, rejects any private or
mixed public/private answer set, and pins the chosen validated public IP on both
upstream and direct paths. CONNECT receives an IP, never a hostname to re-resolve.
HTTP Host and HTTPS SNI/certificate verification use the original destination.
Raw-IP HTTPS verifies the IP identity. Browser CONNECT is an end-to-end tunnel,
with certificate verification performed by the browser.

Retrieval/login destinations remain limited to ports 80/443; desktop anyPort
continues to permit other public ports. Existing read-only HTTP method controls,
browser-specific request controls, byte budgets, cancellation, and 30-second tunnel
idle timeouts remain in force. CONNECT headers are bounded, and the browser's
64 KiB pre-tunnel buffer bounds only negotiation buffering, not total downloads.

The onRoute callback reports transport (request/browser-http/browser-connect),
route (upstream/alpha), fallback (boolean), and reason (configured/unconfigured
or a fixed availability error code). It contains no URL, hostname, credentials,
request headers, or body. Ordinary retrieval trace entries include this egress
selection. By default only fallback selections produce a structured
patronus_egress warning, including browser/solver paths. An observer exception
cannot change routing. Selection reports an attempted path, not proof that the
destination accepted a request or a claim about the phone's actual public IP.

## Explicit exclusions

This is preferred web-transport routing, not an all-network privacy guarantee:
- DNS stays on Alpha's OS resolver. No DNS provider, system resolver, Tailscale DNS
  configuration, or host routing is changed.
- Tailscale control-plane traffic and unrelated Alpha services do not move.
- Gateway OAuth/inbound serving, local Unix-socket control calls, helper scripts,
  and traffic outside reader request/browser proxy paths are excluded.
  Browser protocols outside these proxy paths are not claimed.
- Solver API calls use this preference/fallback policy, but third-party solver
  workers' own connections to challenge sites are not controlled by Patronus.

## Validation and rollout

test/default-egress.test.js uses local HTTP/CONNECT/TLS fixtures, mock public DNS
answers, process-local fixture certificate trust, and mocked direct transports.
It covers HTTP/download and HTTPS routing; SNI/certificate/IP identity; redirect
header stripping and per-hop DNS/port checks; route overrides; browser HTTP and
CONNECT; SSRF; proxy denial/malformed/closed/unavailable responses; offline-like
502/503/504 and timeout fallback; cancellation; response cleanup; byte budgets;
half-close behavior; healthy recovery on the next request; secret-free diagnostics;
and solver POST/no-redirect/error masking. Write tests prove single dispatch,
no replay after uncertain results, and no security-error fallback. Installer
retention tests execute only its isolated prune conditional and assert that the
AppArmor installation remains outside and before it.

No live authentication or paid CAPTCHA call is required by unit fixtures.
Review/publish the tested revision, preserve live sessions as required, and use
the registered rollout procedure with approved environment and security-policy
changes. Verify normal phone egress and isolated controlled unavailable-upstream
Alpha fallback, without taking the phone offline or interrupting an active user
session. Live site login is a separate action, not a routing smoke test.
