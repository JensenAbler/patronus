# Mirror

A self-hosted page that records what a website can see about a visitor, so Patronus can
"look in the mirror" before it goes out.

- `GET /mirror/?label=NAME` serves the probe. The server notes the request headers and their order.
- The page measures navigator, client hints, screen, timezone, WebGL renderer, canvas, fonts,
  media devices, voices, permissions, `window.chrome`, automation globals, the CDP
  `Runtime.enable` leak and `navigator.webdriver` (including whether it was patched), then
  POSTs the result to `/mirror/report`. It shows the same data to the visitor.
- Reports append to `/var/lib/patronus-mirror/reports.jsonl`. There is no read endpoint.
- `node mirror/diff.mjs /var/lib/patronus-mirror/reports.jsonl <baseline> <label>...` lists every
  field where a run differs from a baseline (for example `jensen-iphone` or `jensen-laptop`).
- Served at `https://mcp.jensenabler.com/mirror/` by `patronus-mirror.service` (port 8807).

Eval runs should visit the mirror first with a label per arm (`patronus-headless`,
`patronus-headed`, ...). The page prints `MIRROR_DONE` when recorded.
