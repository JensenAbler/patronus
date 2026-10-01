# SolveCaptcha

Optional solving works during X10 login and browser read/explore jobs for reCAPTCHA v2 (including invisible widgets), standalone Cloudflare Turnstile, hCaptcha, and image CAPTCHAs with one clearly associated answer field. Managed Cloudflare challenge pages, reCAPTCHA v3/Enterprise, and grid tasks remain unsupported. Missing or disabled configuration retains the existing challenge behavior. HTTP/download jobs do not use the solver.

Provision /var/lib/patronus/solvecaptcha.json outside Git, owned by patronus with mode 0600. Use these fields: enabled (boolean), apiKey (the private SolveCaptcha key), and maxTasksPerJob (integer 1–5; recommend 1 initially). Patronus reads its own configuration directly and has no Praxis dependency. Do not reuse or read Praxis credentials at runtime.

When configured, solving is enabled by default; set solveCaptchas=false on patronus_start or patronus_login to disable it for that job. Each submission can incur a provider charge. The provider receives the page URL and public widget site key for token challenges; for image CAPTCHAs it receives a PNG crop of the challenge image only. Patronus does not send account passwords, browser cookies, full-page screenshots, or browser profiles. A URL may contain private parameters, so disable solving for URLs that should not be shared with this provider.

Each paid submission is preceded by a durable receipt. Returned task IDs, state, and sanitized error codes are available in solverAttempts on patronus_status. API keys and returned solution tokens are never saved in those receipts. Submission failures are treated as uncertain and never retried automatically. Restarted jobs fail with INTERRUPTED and keep their receipts. Recover the existing job ID rather than using a new idempotency key after uncertainty.

Polling waits 20 seconds initially for reCAPTCHA and five seconds for other types, then five seconds between checks. At most 48 result checks occur for hCaptcha and 24 for other types; the overall job deadline can end polling earlier. X10's default deadline is 180 seconds (maximum 300). The configured per-job task cap applies across all pages.

Browser callbacks may complete CAPTCHA verification, but arbitrary forms and account writes remain blocked. X10 alone retains its single credential submission. Applying a token does not prove that the site accepted it: retrieval still checks denial status/title, and X10 still requires the authenticated portal marker. Multi-widget and unknown challenges fail closed.

API reference: https://solvecaptcha.com/captcha-solver-api

Before deployment, run npm test and authenticated MCP integration checks on the reviewed managed workspace revision. Publish and install only that reviewed commit, retain the previous release, and preserve profiles and jobs.

Image recognition requires a text input identified as a CAPTCHA and exactly one nearby CAPTCHA image; ambiguous pairs, hidden images, oversized crops, and changed fields fail closed. The answer is filled with normal input events; forms are not submitted. hCaptcha fills both its own response field and its reCAPTCHA compatibility field when present. Current provider docs omit hCaptcha, but an authenticated method=hcaptcha submission was accepted on 2026-10-01; both image CAPTCHA and hCaptcha demo submissions were accepted on 2026-10-01. Use a 300-second job deadline for hCaptcha's slower queue (the general retrieval default remains 120 seconds).
