# Patronus

Use managed Praxis workspaces for source edits, tests, review, commit, and push.
Deploy only the reviewed published revision. Do not edit installed source in place.
Keep credentials, browser profiles, retrieval results, and other private runtime
state outside Git and routine diagnostics. Preserve existing jobs and profiles
during updates, retain a working release, and never replay ambiguous retrievals.
Run npm test and authenticated MCP integration checks before deployment.
Patronus must remain usable without a running Praxis service. Do not introduce
Praxis-specific imports, credential reads, or runtime requests.
