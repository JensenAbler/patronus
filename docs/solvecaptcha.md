# SolveCaptcha

Optional token/image-answer solving works during X10 login and browser read/explore jobs for reCAPTCHA v2 (including invisible widgets), standalone Cloudflare Turnstile, hCaptcha, and image CAPTCHAs with one clearly associated answer field. Managed Cloudflare challenge pages and reCAPTCHA v3/Enterprise remain unsupported. These token paths do not solve grid tasks; the separate desktop coordinate path below can submit visible click challenges. Missing or disabled configuration retains the existing challenge behavior. HTTP/download jobs do not use the solver.

Provision /var/lib/patronus/solvecaptcha.json outside Git, owned by patronus with mode 0600. Use these fields: enabled (boolean), apiKey (the private SolveCaptcha key), and maxTasksPerJob (integer 1–5; recommend 1 initially). Patronus reads its own configuration directly and has no Praxis dependency. Do not reuse or read Praxis credentials at runtime.

When configured, solving is enabled by default; set solveCaptchas=false on patronus_start or patronus_login to disable it for that job. Each submission can incur a provider charge. The provider receives the page URL and public widget site key for token challenges; for image CAPTCHAs it receives a PNG crop of the challenge image only. Patronus does not send account passwords, browser cookies, full-page screenshots, or browser profiles. A URL may contain private parameters, so disable solving for URLs that should not be shared with this provider.

Each paid submission is preceded by a durable receipt. Returned task IDs, state, and sanitized error codes are available in solverAttempts on patronus_status. API keys and returned solution tokens are never saved in those receipts. Submission failures are treated as uncertain and never retried automatically. Restarted jobs fail with INTERRUPTED and keep their receipts. Recover the existing job ID rather than using a new idempotency key after uncertainty.

Polling waits 20 seconds initially for reCAPTCHA and five seconds for other types, then five seconds between checks. At most 48 result checks occur for hCaptcha and 24 for other types; the overall job deadline can end polling earlier. X10's default deadline is 180 seconds (maximum 300). The configured per-job task cap applies across all pages.

Browser callbacks may complete CAPTCHA verification, but arbitrary forms and account writes remain blocked. X10 alone retains its single credential submission. Applying a token does not prove that the site accepted it: retrieval still checks denial status/title, and X10 still requires the authenticated portal marker. Multi-widget and unknown challenges fail closed.

API reference: https://solvecaptcha.com/captcha-solver-api

## Persistent desktop click challenges

The desktop keeps its X11-only design: no remote debugging, DOM inspection, token injection, extension, or credential changes are introduced. Use `patronus_desktop` with `action:"screenshot"`, then `action:"solveCaptcha"` with that response's `screenshotSha256`, a `crop:{x,y,width,height}` containing only the CAPTCHA image, and its visible `instructions`. Coordinates use the 1280×720 screenshot. The screenshot must be the latest observed frame and no older than 30 seconds; crops are 20–600 pixels per side and encoded under 100,000 bytes. Never include login fields or unrelated private content.

This explicitly invokes the configured paid SolveCaptcha ClickCaptcha method (`method=base64, coordinatescaptcha=1`), which receives only the cropped JPEG and instructions. The full screenshot, URL, credentials, cookies, and browser profile are not sent. One submission is made per desktop CAPTCHA job. The returned job ID is durable: recover through `patronus_status` or `patronus_result`; retry the exact same idempotency key after an uncertain response, never a new key.

The call returns promptly while polling runs server-side. Default timeout is 180 seconds, configurable from 30 to 300. While a task is running, other desktop input is refused; screenshots and cancellation remain available. Provider submission receipts are saved before the paid POST. Restart/cancellation never resubmits the task.

Success means coordinates were returned, not that the website accepted verification. Results contain absolute screenshot coordinates in `desktopCaptcha.points`. Inspect a fresh screenshot and confirm the same challenge still occupies the same crop before applying normal desktop clicks. Changing/dynamic tiles require a new observed crop and explicit solve. The solver never clicks, verifies, or submits forms on its own. Finish with actual on-page verification and authentication evidence.

Official screenshot-coordinate example: https://solvecaptcha.com/blog/bypass-slider-captcha-puppeteer

Before deployment, run npm test and authenticated MCP integration checks on the reviewed managed workspace revision. Publish and install only that reviewed commit, retain the previous release, and preserve profiles and jobs.

Image recognition requires a text input identified as a CAPTCHA and exactly one nearby CAPTCHA image; ambiguous pairs, hidden images, oversized crops, and changed fields fail closed. The answer is filled with normal input events; forms are not submitted. hCaptcha fills both its own response field and its reCAPTCHA compatibility field when present. Current provider docs omit hCaptcha, but an authenticated method=hcaptcha submission was accepted on 2026-10-01; both image CAPTCHA and hCaptcha demo submissions were accepted on 2026-10-01. Use a 300-second job deadline for hCaptcha's slower queue (the general retrieval default remains 120 seconds).
