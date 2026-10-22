# Alpha deployment

The reader is patronus.service, using /var/lib/patronus for existing profiles,
jobs, and artifacts. The independent OAuth/MCP gateway is patronus-gateway.service,
using /var/lib/patronus-gateway and credentials under /etc/patronus.
The gateway runs as patronus-gateway, with the patronus group solely for access to
/run/patronus/api.sock. The reader cannot read gateway signing keys or OAuth state.

Run the reviewed installer from a managed workspace after publishing:
`python3 scripts/install-patronus.py . EXACT_PUBLISHED_COMMIT`.
It retains the previous release and unit. After both services are active it runs
scripts/prune-releases.py, which deletes older releases and their AppArmor profiles
but keeps the active release, one rollback target (PATRONUS_KEEP_PREVIOUS, default 1),
any release a live unit executes, and any release whose runtime a kept one symlinks.

For a rollout that must retain every release and AppArmor profile, use the explicit
option PATRONUS_SKIP_PRUNE=1, for example:
`PATRONUS_SKIP_PRUNE=1 python3 scripts/install-patronus.py . EXACT_PUBLISHED_COMMIT`.
Only the exact value 1 skips the entire post-activation prune invocation; the
installer reports prune.skipped=true and reason=PATRONUS_SKIP_PRUNE. Unset, empty,
0, and other values keep normal pruning. This does not skip AppArmor profile
installation, loading, or any browser/security guard. Obtain the required approval
for the new release-specific AppArmor profile before running the installer.

Configure independent credentials with
scripts/create-credentials.js outside Git before first gateway startup.
The HTTPS nginx configuration is deploy/patronus-nginx.conf, included inside the
existing mcp.jensenabler.com TLS server. Discovery aliases are path-qualified so
other applications on the host retain their own OAuth metadata.

Use independent generated credentials. The initial password is stored in the
root-only /etc/patronus/login.txt on Alpha. Signing keys, cookie keys, clients,
and grants are separate from all other applications.

Rollback by restoring previous-service.unit and previous-gateway.unit from the
new release, daemon-reloading, and restarting both Patronus units. Never restore
a database snapshot over accepted jobs. Legacy Praxis socket calls remain valid.

Optional default reader web egress is documented in [default-egress.md](default-egress.md).
Enabling it is a separately approved environment/restart change, not part of the
source installation by itself.
