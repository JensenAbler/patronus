PATRONUS AND NATIVE CLOUD BROWSER EVALUATION KIT
Version 1.0 | Created 2026-10-11 UTC

STATUS
No paired browser trials have run. Patronus capabilities returned connector
transport error -32603 at 20:30 UTC. No target-site winner is established.

START HERE
Read Browser Evaluation Protocol.docx for the full experimental protocol.
manifest.json contains 15 cases, exact tasks, checks, prerequisites and gates.
pilot_schedule.jsonl contains 20 not-run arms for five public cases repeated twice.
availability.json records current service readiness separately.
sources.json records public URL discovery, not browser performance.
observations.jsonl is intentionally empty.
current_results.json correctly reports zero measured pairs.
templates/observation.json is a complete single-arm results template.
templates/routing_map.json is the per-case reporting template.

OFFLINE COMMANDS
Python 3.10 or later; standard library only; no install, credentials or network.
Run from this directory:

  python3 -m unittest discover -s tests -v
  python3 eval.py plan --seed 10112026 --repeats 2 --out pilot_schedule.jsonl
  python3 eval.py validate pilot_schedule.jsonl
  python3 eval.py validate observations.jsonl
  python3 eval.py summarize observations.jsonl --out current_results.json

To plan all resolved public cases, without running any browser:
  python3 eval.py plan --all-public --repeats 12 --seed 10112026 --out public_plan.jsonl

An optional --profile cold_public or --profile warm_public creates a requested
profile stratum. It does not establish an isolated or authenticated browser.
Verify state before running; otherwise mark comparisons unmatched.
Do not hand-edit manifest fields after a schedule is generated without
regenerating the schedule or preserving the old manifest with the observations.

EXECUTION BOUNDARY
This is a working offline planner, validator, scoring specification and analysis
harness, not an untested automatic driver. The supported browser tools are the
execution adapters. The operator enforces timeouts, pacing, permissions and
profile state, and records observations. This avoids inventing unavailable
Patronus desktop endpoints during the outage.

NATIVE BROWSER means the native interactive cloud Chrome, not a textual web
fetch and not Jensen's local desktop. Patronus reader, download and headed
desktop are distinct modes. The currently exposed Patronus API is retrieval-only;
its interactive desktop surface must be verified before interactive cases run.

SAFETY AND DATA
Never collect credentials or secret tokens in the manifest, logs or artifacts.
X10, Loom, DMV and Apple cases remain gated/unresolved. Do not solve challenges,
sign in, submit personal data or accept agreements without applicable approval.
No browser screenshots are included in this deliverable. Save private visual
evidence separately with appropriate redaction and authorization.

LIMITATIONS
A healthy transport preflight is needed on both arms. Unknown cost is null.
No report should call HTTP 200, a login shell or video poster a task pass.
Two pilot pairs do not support a lasting routing rule. See the protocol for
minimum samples, paired analysis, versioning and domain-level limits.
No recurring schedule, Alpha repository modification, commit, push or deployment
has been performed.
