#!/usr/bin/env python3
"""Stage only the reviewed, published temporary extension. No service/browser changes."""
import hashlib
import json
import os
import pathlib
import pwd
import re
import shutil
import sys
import tempfile

FILES = ("manifest.json", "devtools.html", "devtools.js", "panel.html", "panel.css", "panel.js", "core.js")
BASE = pathlib.Path("/var/lib/patronus/temporary-diagnostics")

def stage(source, revision, base=BASE, owner=None):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Exact verified published commit required")
    source = pathlib.Path(source).resolve() / "diagnostics" / "lever-verification"
    data = {}
    for name in FILES:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("Expected regular extension file missing")
        value = path.read_bytes()
        if len(value) > 131072:
            raise ValueError("Unexpected extension file size")
        data[name] = value
    manifest = json.loads(data["manifest.json"])
    for key in ("permissions", "host_permissions", "optional_permissions", "optional_host_permissions", "background", "content_scripts", "externally_connectable"):
        if key in manifest:
            raise ValueError("Unexpected extension access")
    if manifest.get("devtools_page") != "devtools.html" or manifest.get("manifest_version") != 3:
        raise ValueError("Unexpected extension manifest")
    if manifest.get("content_security_policy", {}).get("extension_pages") != "script-src 'self'; object-src 'none'; connect-src 'none'":
        raise ValueError("Unexpected extension CSP")
    base = pathlib.Path(base)
    if base.is_symlink():
        raise ValueError("Staging base must not be a symlink")
    if not base.exists():
        base.mkdir(mode=0o750)
        if owner:
            os.chown(base, owner[0], owner[1])
    target = base / ("lever-verification-" + revision)
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_dir() or set(p.name for p in target.iterdir()) != set(FILES):
            raise ValueError("Existing staging target differs")
        for name, value in data.items():
            path = target / name
            if path.is_symlink() or not path.is_file() or path.read_bytes() != value:
                raise ValueError("Existing staging target differs")
        return target
    with tempfile.TemporaryDirectory(prefix=".lever-stage-", dir=base) as tmp:
        staging = pathlib.Path(tmp)
        os.chmod(staging, 0o750)
        if owner:
            os.chown(staging, owner[0], owner[1])
        for name, value in data.items():
            path = staging / name
            path.write_bytes(value)
            os.chmod(path, 0o640)
            if owner:
                os.chown(path, owner[0], owner[1])
        # A new immutable directory, never changes a previous install in place.
        staging.rename(target)
    return target

def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: stage-verification-diagnostic.py REVIEWED_SOURCE VERIFIED_PUBLISHED_COMMIT")
    # Publication verification belongs to the caller's Praxis receipt workflow.
    # Do not read credentials or use a network/Git credential from this installer.
    account = pwd.getpwnam("patronus")
    target = stage(sys.argv[1], sys.argv[2], owner=(0, account.pw_gid))
    print(json.dumps({"extensionDirectory": str(target), "files": len(FILES), "browserChanged": False, "servicesChanged": False}))

if __name__ == "__main__":
    main()
