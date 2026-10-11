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
