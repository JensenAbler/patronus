# Bounded verification control

This is a reviewed-input control path, not a CAPTCHA discovery system. It uses
the existing configured SolveCaptcha service and native reader input. It never
uses a browser extension, changes browser identity, rotates proxies, suppresses
security warnings, refreshes challenges, or retries unknown native input.

## Scope and remaining validation

The production adapter completes at most one explicitly invoked answer-selection
round, then stops for control review. Automatic Next/Verify is hard-disabled
until real positive button fixtures have been validated. The generic runner has
exact two-scale label agreement logic exercised with mocks; that does not prove
live recognition. Skip fixtures do not establish Next/Verify behavior.

A selected answer, a closed panel, or a successful solver job does not establish
website acceptance or application submission. Check website confirmation and any
receipt independently. No application or live solver was used in offline tests.

## Prepare before opening a challenge

1. Prepare the command, private evidence directory, and approved round budget.
2. Review the actual visible challenge prompt, geometry and session. Build the
   small spec: reviewed:true, type:select or drag, session (desktop startedAt),
   instructions (at most140 characters), image, anchorRectangle,
   controlRectangle, panelRectangle, anchorHash and observedImageHash.
   Hashes are SHA-256 of the existing cropFrame JPEG output. Rectangles are
   integer screenshot coordinates within1280×720 and remain inside the reviewed
   CAPTCHA panel; each is at least20×20 and at most600×600.
3. The anchor is a stable, distinctive CAPTCHA-only area, excluding selections
   and the mouse pointer. The image is the exact solver crop. Drag specs also
   require a reviewed source rectangle and source.center.
4. Invoke the prepared command with the spec and a unique attempt ID:
   node scripts/verification-round.js REVIEWED_SPEC.json PRIVATE_DIRECTORY ATTEMPT_ID
5. The adapter checks nativeGuardVersion1 and reader-owned lease support. It
   captures/checks/starts the solver within one host operation, polls that same
   job using status.state, validates screen-relative points, then checks every
   input and retains each returned challenge frame. No model turn belongs in
   the polling/input sequence. A new prompt/geometry still needs review.

The runner has bounded calls, a solver deadline, a round budget, and no automatic
new-challenge loop. Its timeout limits its wait, not the native process. An
unknown response stops the attempt. The reader lease stays held/draining until
the native operation actually settles.

## Optional native-cursor-excluded comparisons

Default desktop screenshots still include the native pointer. The existing
desktop API accepts comparisonOnly:true for screenshot, or guarded click, drag
and solveCaptcha. This changes capture only; an input or solver action still
executes. The explicit option uses x11grab draw_mouse=0. It does not move the
pointer, change browser content, remove page-drawn marks or suppress hover state.

To use it, require capabilities.desktopControl.cursorNeutralComparison=true,
obtain a new comparisonOnly screenshot and review a new spec with
comparisonOnly:true. Pass comparisonOnly:true to createVerificationSession (the
CLI reads this from the reviewed spec). Source, fresh reader guard, solver crop,
returned frame and retained evidence then use the same capture policy. Mode
mismatches fail closed. Never reuse cursor-inclusive baseline hashes or resume
an already halted attempt. Exact recorded paid requests still recover without
another solve; comparison mode is part of that immutable request.

This option removes only native-pointer contamination. A page-painted circular
X, selection overlay, hover change, tile replacement or any other changed image
still stops remaining points. There is no changed-region mask or tolerant image
match. The real before/after fixture does not establish whether its circular X
is native cursor content, hover state, persistent selection or accepted input.

A future pointer-away evidence probe would need an explicitly supported,
reviewed, non-clicking guarded movement action under the same reader lease,
session and deadline. No such desktop API action exists in this revision. Do not
substitute a zero scroll, click, drag or direct X command. After separate approval
and support, pair cursor-excluded captures before and after a single move to a
reviewed neutral location, with no buttons or keys. Stop on panel/session/owner
change; use the pair only to classify persistence, never as proof of acceptance.

The isolated synthetic X11 regression can be run with
PATRONUS_X11_CAPTURE_TEST=1 node --test test/desktop-comparison-x11.test.js.
It creates its own temporary X display and painted window, never a browser.

## Reader-owned control

The private Unix protocol owns one lease across gateway and direct-reader calls.
Owner takeover cannot overlap a reader operation. Each owner acquisition increments
an epoch; the runner pins that value and stops if the owner intervened during
solver polling, even when the owner has already released control. Owner15-minute and agent
60-second leases expire into draining state; an in-flight native operation must
settle before another owner or agent can acquire control. Lease tokens never
appear in public capability/status responses. Status exposes only safe state.

Native input pins the original display/session and checks its deadline and lease
before each command, including the final click after pointer movement. Timeouts
kill a native input child and wait for its close event. Drag always attempts
button-up on the original display. These checks cannot freeze a website between
pixels and a click or establish that the website processed the event.

Pointer motion and input pacing are deterministic. Previous random-jitter
behavior and anti-detection comments have been removed. This is ordinary native
input; it provides no universal access guarantee and never overrides denials.

## Evidence and uncertainty

The adapter creates a private append-only attempt journal before work. Reusing
the same attempt ID in a new process is refused. Exact solver request arguments
and the durable returned job ID are retained for read-only recovery. Retrying an
existing paid key returns the original job before expired-image/deadline checks.
Never change that key to resolve an unknown response.

Guarded native input has a durable reader-side command receipt. The same key
cannot dispatch again, including after screenshot failure or reader restart.
Ordinary unguarded desktop actions remain non-idempotent and are advertised as
such; do not replay them after an unknown result.

For challengeEvidence:true, guard checks are ordered anchor, image, control.
The reader saves source crops before native dispatch and returned crops before
responding, even if the caller loses the response. If the returned anchor is
absent or changed, it saves metadata only. It never saves a full application
frame. Files are owner-only beneath runtime desktop-evidence; runtime evidence,
application content, browser profiles and credentials stay outside Git.

Screenshot pixels include the mouse pointer. Exact comparisons can therefore
stop conservatively on a moving pointer, selection overlays or dynamic tile
replacement. Do not loosen them with perceptual tolerances. After every click,
compare the challenge image to the original solve source before any remaining
solver point. Any image change stops the remaining points, including a legitimate
selection overlay. A selection-only transition recognizer has not been validated;
there is no silent rebaseline that could accept dynamic replacement tiles.

## Rollout

Publish only after review and explicit approval. This change requires coordinated
gateway AND reader deployment; the old reader lacks the lease and native guard
protocol. Gateway-only installation is insufficient. The existing full installer
restarts patronus.service, which stops/restarts Chrome. Its current application
form and challenge may be lost; preserve approved application inputs first.
Persistent browser profiles and jobs must remain untouched. No restart, commit,
push or deployment is part of the offline implementation task.

Run npm test, including authenticated local MCP integration. After authorized
rollout, verify the exact published revision, safe capability fields and control
availability before any separately authorized live attempt. Existing deployment
process health is not proof of website acceptance.
