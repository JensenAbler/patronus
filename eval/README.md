# Patronus retrieval eval

A corpus of real URLs that assistants have asked Patronus to read, each with the
outcome we expect and the outcome we actually observed. It exists so changes to
Patronus can be checked against pages that matter in practice, not just
example.com.

- `corpus.json` holds the cases. Each case names a URL, the request options, what a
  good result looks like (`expect`), and dated observations from Patronus and, for
  comparison, from other retrieval routes (an assistant's plain fetch tool, the
  Google Drive connector).
- `test/eval-corpus.test.js` validates the corpus shape offline as part of
  `npm test`. It does not fetch anything.

The corpus stores URLs and short expectation strings only. Do not commit retrieved
page content, screenshots, cookies, or anything from a logged-in session; that
stays in Patronus's private job store per AGENTS.md.

## Browser comparison kit (`browser-comparison/`)

A paired-trial protocol comparing Patronus against a native interactive cloud
Chrome, drafted on 2026-10-11 by OpenAI's Dots agent while it could not reach
Patronus (its probe got MCP error -32603 at 20:30 UTC). The same afternoon,
Patronus answered Claude's calls normally between about 20:27 and 20:45 UTC, so
that error looks like Dots' connector path rather than a Patronus outage.

It is a standard-library Python harness: `PROTOCOL.md` explains the design
(converted from the original Word document, which is kept outside git),
`manifest.json` holds the cases, and `eval.py` plans counterbalanced trial
schedules, validates observation logs, and summarizes paired results. It does
not drive a browser; an operator runs each arm with the real tools and records
the result. Start with `browser-comparison/README.txt`.

Changes made when merging it here:

- Added cases R01-R10, one per URL in `corpus.json`. Each carries a `corpus_ref`
  pointing at its corpus entry. They are not in the pilot, so the 20-arm pilot
  schedule covers the same five cases as before; it was regenerated because the
  manifest hash changed.
- `SHA256SUMS.json` was refreshed to match and no longer lists the Word file.
- `test/browser-comparison-kit.test.js` runs the kit's unit tests and validates
  its schedules under `npm test` (skipped if `python3` is unavailable).

The two files answer different questions. `corpus.json` is the running record of
what actually happened when assistants used Patronus. The kit's manifest is the
preregistered protocol for deciding, with enough paired trials, when to route a
task to Patronus instead of a native browser.

## Case fields

| field | meaning |
|---|---|
| `id` | stable kebab-case identifier |
| `url` | the URL as an assistant would submit it (tracking params stripped) |
| `request` | `patronus_start` options to use (`mode`, `rendering`, `browser`, ...) |
| `expect.outcome` | `content` (page text should come back) or `obstacle` (a specific, named obstacle is the correct answer) |
| `expect.titleIncludes` / `expect.textIncludes` | substrings a good result must contain |
| `expect.obstacleCode` | for `obstacle` cases, the code we want reported |
| `observed[]` | dated results: `route`, `result` (`pass`, `partial`, `fail`, `not-run`), and a short note |
| `tags` | grouping, e.g. `login-wall`, `google-docs`, `redirect` |

## Adding cases

Append to `corpus.json`, keep ids unique, and record what actually happened with
the date. A case whose current observation is `fail` or `partial` is a known gap,
not a broken test.
