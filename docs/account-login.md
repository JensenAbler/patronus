# Authorized account login

`patronus_login` accepts account `x10`, an idempotency key, and a deadline. It queues a durable operation; use status and result to recover it. ChatGPT owns any recurring schedule. No automatic scheduler is installed here.

Provision `/var/lib/patronus/accounts/x10.json` outside Git, owned by patronus, mode 0600, with email and password fields. The file is read only inside the login worker. Each account has a separate persistent browser profile. Neither credentials nor page HTML, screenshots, cookies, or response bodies are included in login results or diagnostics.

Only the explicitly authorized X10 login endpoint can receive a single credential POST. Retrieval write restrictions remain unchanged. A normal reCAPTCHA checkbox may be clicked; visible image challenges or missing verification return HUMAN_CHALLENGE_REQUIRED. No solver, token forgery, address rotation, or challenge bypass is implemented. A fresh authenticated portal with a logout marker is required for freshLogin=true. Existing authenticated sessions are reported separately; this does not assert that X10's inactivity timer was reset.

Interrupted jobs are never automatically replayed. Recover status before making a new attempt. Do not blindly resubmit credentials or evade explicit service denials.
