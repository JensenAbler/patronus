# Same-session phone handoff

The optional owner-only page is at /patronus/handoff on the existing HTTPS gateway.
Enable PATRONUS_HANDOFF=1 only after the owner approves remote browser control.

The owner signs in with the existing Patronus password. A Secure, HttpOnly,
SameSite=Strict host-only cookie identifies an in-memory session, with a hard
15-minute expiry and no refresh token. Passwords, cookie values, screenshots and
input are never logged or stored by this feature. No bearer token appears in a URL.

Take control grants a single exclusive lease. The page refreshes X11 screenshots
and maps touch coordinates onto the existing desktop. Inputs include click,
scroll, fixed navigation keys and explicit owner-entered text. Keyboard focuses a
native masked phone input; Send text types into the selected remote field. Text
is sent only on explicit Send, never recorded or echoed, and is cleared on send,
Done, expiry, backgrounding and control loss. Printable text is limited to 1000
UTF-16 units, with control characters and unpaired surrogates rejected unchanged.
The gateway sends owner-entered text only through the private reader envelope;
the reader writes it to xdotool stdin, not argv, and never journals its value.
The reader-owned lease covers native input until the child closes. Done or expiry
aborts that input and keeps the lease draining until it settles. There is no
credential-reference API, arbitrary tool forwarding, new browser, CDP, VNC or
public port.

The gateway and raw Unix reader share one reader-owned lease. Both reject agent
desktop calls, including screenshots, while the owner holds control. Calls are
serialized and an expired or released in-flight action drains before takeover.
Owner input may interrupt a coordinate solver's polling; an incremented owner
epoch prevents the automated runner from resuming afterward. Solver status and
cancellation remain available. There are no automated handoff clicks or retries.

Done revokes the session immediately. Page close attempts the same revocation;
if the connection disappears, the lease releases after 60 seconds without a
frame/heartbeat. Absolute expiry always applies. A gateway restart revokes all
sessions. Input requires exact Origin, a per-session CSRF value, a recent frame,
and the next one-use action sequence. Lost responses are not replayed. Late
responses cannot redraw after Done, expiry or backgrounding. Returning from the
background revalidates; page-history restoration reloads the authenticated page.

Before input the gateway checks the current reader-reported desktop identity
and passes the displayed session in the private call envelope. The reader checks
it again before starting and pins the original display/session for native input.
The post-action frame checks identity again. A website can still change between
a screenshot and a click; these checks do not freeze its contents. Interrupted
text may have typed a prefix; inspect the field before resending. Native children
remain under the reader lock until their close event.

The reader-owned control release requires coordinated gateway and reader
activation from a reviewed, published revision. The old gateway-only installer
is insufficient. The full installer restarts the reader and Chrome, so preserve
approved application inputs and obtain rollout approval before running it.
See docs/verification-control.md for the bounded runner and remaining validation.

Verification: npm test includes security/lifecycle tests with synthetic pixels
and fixture credentials. scripts/handoff-mobile-smoke.js exercises touch mapping
and the UI at an iPhone viewport using a mock desktop. It never reads or operates
the real desktop. Owner sign-in and a real CAPTCHA remain user validation.
