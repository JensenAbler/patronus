# Patronus

A persistent personal web reader living on Alpha. Patronus retrieves rendered pages,
images, and direct downloads using preconfigured browser sessions. Jobs survive
client disconnection and never pause to request credentials.

Connect directly using **https://mcp.jensenabler.com/patronus/mcp** with OAuth.
Patronus owns its OAuth issuer, signing keys, consent, refresh tokens, and service.
Praxis is a development tool and optional compatibility client, not a runtime dependency.

## Development

Node >=22.22.0. Run `npm ci`, then `npm test`.
`npm start` starts the authenticated MCP gateway; `npm run reader` starts the
private Unix-socket worker. See [deployment](docs/deployment.md) and
[reader behavior and evidence](docs/reader.md).

Tools: patronus_capabilities, patronus_start, patronus_status, patronus_jobs,
patronus_result, patronus_artifact, and patronus_cancel. OAuth scope
`patronus:read` authorizes these retrieval and job-management operations, including
downloads and cancellation. It does not authorize arbitrary execution or posting.

Browser sandboxing, public-address-only networking, GET/HEAD policy, bounded
retrieval, and private artifacts remain enforced. Downloads from Mega need an
adapter; direct HTTP files work. Website access is not guaranteed.

## Provenance

Extracted from [JensenAbler/Praxis at ef0dfc0](https://github.com/JensenAbler/Praxis/tree/ef0dfc041896f75f2759900357673264792e8565).
Earlier history remains there. The OAuth implementation was adapted from the same
source with Patronus-specific scopes, branding, and independent state. This
repository contains source only, never browser profiles, OAuth credentials, or
retrieved private content.
