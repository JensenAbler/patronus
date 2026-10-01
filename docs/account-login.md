# Authorized account login

`patronus_login` accepts account `x10`, an idempotency key, and a deadline. It queues a durable operation; use status and result to recover it. ChatGPT owns any recurring schedule. No automatic scheduler is installed here.

Provision `/var/lib/patronus/accounts/x10.json` outside Git, owned by patronus, mode 0600, with email and password fields. The file is read only inside the login worker. Each account has a separate persistent browser profile. Neither credentials nor page HTML, screenshots, cookies, or response bodies are included in login results or diagnostics.

Only the explicitly authorized X10 login endpoint can receive a single credential POST. Retrieval write restrictions remain unchanged. A normal reCAPTCHA checkbox is tried first. If verification remains incomplete, privately configured [SolveCaptcha](solvecaptcha.md) may obtain a reCAPTCHA v2 token within the job deadline and per-job task cap. Set solveCaptchas=false to disable paid solving. Missing configuration or unsupported challenges retain bounded verification diagnostics; no address rotation is used. A fresh authenticated portal with a logout marker is required for freshLogin=true. Existing authenticated sessions are reported separately; this does not assert that X10's inactivity timer was reset.

Interrupted jobs are never automatically replayed. Recover status before making a new attempt. Do not blindly resubmit credentials or evade explicit service denials.


Login diagnostics now persist stage timestamps, bounded response status/redirect paths, and blocked-request destinations. Query values, request bodies, cookie values, and sensitive response headers are excluded. Failure evidence includes the final URL, page title, and redacted visible errors. An applied CAPTCHA token is not proof of server acceptance. Diagnostics do not cause additional login submissions or change the existing one-submit policy.

Use sessionOnly=true for a dedicated saved-session check. This does not read
the account credential file, invoke a solver, fill fields, or submit a form.
An unsuccessful check returns SESSION_NOT_AUTHENTICATED, not a verified login.
Authentication evidence records the final path, password-field count, and an
exact same-origin logout endpoint. Navigation races are retried within the
existing bounded wait. Both success and failure retain submission timestamps.
The login form diagnostic records field names/types and CAPTCHA-token presence,
never field values. A generic /error page is X10_ERROR_PAGE; only an observed
401, 403, or 429 establishes the corresponding HTTP denial category. After an
error redirect, one GET to /login checks whether the existing session is
authenticated; credentials are never resubmitted during this recovery.

Credential POST redirects are fetched without automatic following; only same-origin 302/303 redirects to non-action endpoints are accepted. Redirects that could replay the POST or send credentials to another origin are blocked.

Credential-response HTTP evidence is retained even if its redirect is blocked. Cookie evidence contains only session/remember-cookie presence and session expiry, never cookie values. Portal markers on an HTTP error response do not count as authentication.

Specific X10 error-page feedback is stored in serverDiagnosis, including a bounded
support code, category, stated minimum wait, and whether provider review is needed.
The generic Unknown Error page's list of possible causes is never treated as a
specific diagnosis. Explicit browser/IP/network/country block pages stop the worker
without another navigation or credential submission. Diagnostics also distinguish
request-policy blocks that occurred before the credential response from later
asset blocks. No browser identity or network changes are made to bypass a block.

## Screenshot-driven computer use

Set `interaction:"computer-use"` on `patronus_login`. The job opens the existing
Chromium/profile in headed mode and waits for agent actions for up to the job's
300-second deadline. No new model, remote viewer or credential transport is added.
The agent reads `computerUse.screenshotArtifactId` via `patronus_artifact`, looks
at the masked screenshot and chooses coordinates. The browser worker does not
choose targets from DOM selectors.

Use `patronus_login_action` with the job ID, a unique action idempotency key,
the latest screenshot artifact ID, and an action: `snapshot`, `click`,
`credential`, `press`, `solveCaptcha`, `submit`, or `finish`.
Coordinate actions use viewport pixels. `credential` accepts only the private
`email` or `password` reference and types it with normal keyboard events into
a validated field under those coordinates; secret values are never tool inputs.
Solve CAPTCHA before filling credentials. `solveCaptcha` is an explicit use of
the configured solver; a token remains unproven until the site accepts it.
`submit` arms one POST and clicks the native submit button under the coordinates;
it does not invoke requestSubmit or a JavaScript click. Ordinary clicks and keys
cannot arm credential submission. DOM checks validate credential/submit targets
and authenticated portal markers; they do not select interactive targets.

Action receipts and masked screenshots are durable. Repeating the same completed
action key returns its receipt without repeating input. Interrupted actions are
uncertain and never replayed. A service restart ends the live browser session;
recover its job and receipts rather than claiming the process survived.
Stale screenshots, out-of-viewport coordinates, concurrency and excess actions
are rejected. Session-only computer-use probes forbid credential typing, solving
and submission. Cancellation/deadline close the browser and retain evidence.
Existing cooldown, sandbox, network and authenticated-portal checks still apply.
