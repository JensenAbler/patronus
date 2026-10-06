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
The gateway writes text to xdotool stdin, not argv, using its existing local X11
access. Its exclusive lease/inFlight lock covers this direct input; it does not
use reader-side desktopBusy/solver gating. No agent should drive the privileged
socket during handoff. There is no credential-reference API, arbitrary tool
forwarding, new browser, CDP, VNC or public port.

The gateway blocks all MCP desktop calls while the human owns the lease. Direct
root/Unix-socket operational access remains privileged and must not be used to
drive or observe this desktop during a human handoff. Reader-side desktop actions
remain serialized. There are no automated clicks or login retries.

Done revokes the session immediately. Page close attempts the same revocation;
if the connection disappears, the lease releases after 60 seconds without a
frame/heartbeat. Absolute expiry always applies. A gateway restart revokes all
sessions. Input requires exact Origin, a per-session CSRF value, a recent frame,
and the next one-use action sequence. Lost responses are not replayed. Late
responses cannot redraw after Done, expiry or backgrounding. Returning from the
background revalidates; page-history restoration reloads the authenticated page.

Before input the gateway checks the current reader-reported desktop identity.
If Chrome restarted since the displayed frame, input is rejected. Because this
release deliberately preserves the running reader, that check and input are
separate operations (Unix-socket input for clicks/keys, local xdotool stdin for
text); a crash exactly between them is a residual race. The gateway serializes
all handoff actions, and the post-action frame checks identity again. Interrupted
text may have typed a prefix; the owner must inspect the remote field before
resending. The text child remains under the gateway lock until its close event.

For this gateway-only change, use scripts/install-handoff-gateway.py with the
reviewed, published source tree, exact new commit and expected current gateway
commit. It restarts only patronus-gateway, checks the reader and Chrome main PIDs
stay unchanged, and rolls back the gateway unit if activation fails. Do not run
the full installer while a challenge is open: that would restart the reader.

Verification: npm test includes security/lifecycle tests with synthetic pixels
and fixture credentials. scripts/handoff-mobile-smoke.js exercises touch mapping
and the UI at an iPhone viewport using a mock desktop. It never reads or operates
the real desktop. Owner sign-in and a real CAPTCHA remain user validation.
