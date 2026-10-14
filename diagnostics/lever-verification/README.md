# Temporary Huckleberry verification metadata diagnostic

Purpose: inspect one explicitly approved application's future verification requests using the supported Chrome DevTools network API. This does not solve a CAPTCHA, change a token, submit a form, change routing, alter browser signals, or explain Lever's private server decisions.

## Scope and data limits

- Exact inspected application page and POST path: https://jobs.lever.co/Huckleberrylabs/871ce846-02d4-43c5-b54c-426060fc08c4/apply (query/fragment ignored and never output).
- hCaptcha HTTPS requests from that inspected page: hcaptcha.com or its subdomains; timing and status only. Response bodies are never requested.
- Manual arm, a 15-minute maximum, at most 64 redacted rows per category and eight ephemeral salted SHA-256 digests for same-session repeated-token comparison. Stop/clear, leaving the page, timeout or panel unload discards state. JavaScript strings cannot guarantee immediate memory zeroization; raw request references/token strings are transient only and never deliberately retained, logged, stored, transmitted, or displayed. Byte buffers are zeroed.
- No background service worker, host permissions, content script, debugger permission, storage, server endpoint, exported file, or network transmission. Extension CSP forbids network connections.
- Chrome's DevTools API delivers inspected-tab event objects; the site restriction is enforced in this code, not by a Chrome host-permission filter. Off-scope URLs are rejected before metadata/body reads, without storage or output.
- Only the exact h-captcha-response form field is read, from structured form parameters or bounded URL-encoded/multipart data. Applicant field values are not decoded or retained. An unavailable, omitted, duplicate, oversized, malformed, or unrecognized field is reported as unknown; an explicitly empty known field is false.
- Output is only normalized request timestamp, HTTP status, token-present/nonempty, repeat-seen boolean (or unknown), and token age fixed to unknown. The repeat comparison covers only this armed session's last eight distinct tokens. A positive token result does not establish token validity or successful CAPTCHA verification.
- Token issuance is not observed or correlated. Do not infer age from a hCaptcha request time.
- Prospective only. No historical log API is called and no HAR is created, retrieved or exported. It cannot recover the already failed request. No new submission should be made merely to populate data.

## Supported installation and removal

1. Review and test the exact code, then follow the repository's normal approved publication process. Verify the remote commit and the unchanged managed workspace revision. Run python3 scripts/stage-verification-diagnostic.py . EXACT_VERIFIED_PUBLISHED_COMMIT from that workspace. This stages only seven static extension files in a new immutable directory under /var/lib/patronus/temporary-diagnostics; it changes no service, profile, browser, launch flag, or system policy. It is idempotent only for an identical tree and refuses a changed existing target. The caller must verify publication; the staging script reads no credentials and does no network access.
2. Obtain release of any active owner browser handoff. Never interrupt credential entry or another user's control.
3. In the existing Chrome session, use a new tab for chrome://extensions. If Developer mode is not already on, enabling it is part of this specifically approved temporary extension install; pause if any unexpected broader permission/policy change is required.
4. Use Chrome's documented Load unpacked button and select this directory in the reviewed published release. Do not use command-line sideloading, alter security policies, disable checks, add remote debugging ports, edit the profile, or restart the browser.
5. Return to the exact application tab, open DevTools normally, choose Verification metadata, and arm it. Do not refresh or resubmit as part of installation.
6. Read the redacted panel only. Never inspect/export the Network panel's raw request fields, console objects, cookies, credentials, or tokens. If the tab/panel must navigate away, stop and clear first.
7. When the authorized investigation finishes, stop/clear, close DevTools, remove this extension in chrome://extensions, and restore Developer mode to its prior setting. Do not touch other extensions or profile data.

The installed Alpha binary was verified as Google Chrome 154.0.8037.97. Official Chrome documentation describes Load unpacked as a supported UI flow. Live loading and DevTools behavior remain unverified until the owner releases the browser; no launch flags are needed.

## Validation

Run node --test test/verification-diagnostic*.test.js, then npm test. Fixtures are synthetic and must remain free of live request objects, tokens and applicant information.

Official references:
- https://developer.chrome.com/docs/extensions/reference/api/devtools/network
- https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked
