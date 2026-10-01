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
