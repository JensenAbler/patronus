#!/usr/bin/env python3
"""Prune installed Patronus releases after a successful activation.

Keeps the active release, its rollback chain (default: one previous release, read from
the previous-service.unit the installer saves), any release a live unit still executes,
and every release whose node_modules/browsers a kept release symlinks into. Everything
else under the releases root that is named by an exact commit is removed, together with
its AppArmor profile. Profiles for releases that are no longer installed are removed too.
"""
import argparse, json, os, pathlib, re, shutil, subprocess, sys

REV = re.compile(r'^[0-9a-f]{40}$')
RUNTIME = ('node_modules', 'browsers')


def release_from_unit(text, root):
    m = re.search(re.escape(str(root)) + r'/([0-9a-f]{40})/', text or '')
    return m.group(1) if m else None


def runtime_owners(root, rev):
    owners = set()
    for name in RUNTIME:
        p = root / rev / name
        if not p.is_symlink():
            continue
        try:
            rel = p.resolve().relative_to(root)
        except ValueError:
            continue
        if rel.parts and REV.match(rel.parts[0]):
            owners.add(rel.parts[0])
    return owners


def plan(root, current, keep_previous=1, units=()):
    root = pathlib.Path(root)
    if not REV.match(current or '') or not (root / current).is_dir():
        raise SystemExit('Active release missing; refusing to prune')
    keep = {current}
    cursor = current
    for _ in range(max(0, keep_previous)):
        saved = root / cursor / 'previous-service.unit'
        prev = release_from_unit(saved.read_text(), root) if saved.is_file() else None
        if not prev or prev in keep or not (root / prev).is_dir():
            break
        keep.add(prev)
        cursor = prev
    for text in units:
        live = release_from_unit(text, root)
        if live and (root / live).is_dir():
            keep.add(live)
    pending = list(keep)
    while pending:
        for owner in runtime_owners(root, pending.pop()):
            if owner not in keep:
                keep.add(owner)
                pending.append(owner)
    remove = sorted(p.name for p in root.iterdir()
                    if p.is_dir() and not p.is_symlink() and REV.match(p.name) and p.name not in keep)
    return sorted(keep), remove


def drop_profile(path, unload):
    if unload and shutil.which('apparmor_parser'):
        subprocess.run(['apparmor_parser', '-R', str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    path.unlink()


def main(argv=None):
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument('--root', default='/srv/patronus/releases')
    a.add_argument('--current', required=True)
    a.add_argument('--keep-previous', type=int, default=int(os.environ.get('PATRONUS_KEEP_PREVIOUS', '1')))
    a.add_argument('--unit', action='append', default=[], help='live systemd unit file whose ExecStart release must be kept')
    a.add_argument('--apparmor-dir', default='/etc/apparmor.d')
    a.add_argument('--no-unload', action='store_true', help='delete profile files without unloading them')
    a.add_argument('--dry-run', action='store_true')
    args = a.parse_args(argv)
    root = pathlib.Path(args.root).resolve()
    units = [pathlib.Path(u).read_text() for u in args.unit if pathlib.Path(u).is_file()]
    keep, remove = plan(root, args.current, args.keep_previous, units)
    removed, profiles = [], []
    apparmor = pathlib.Path(args.apparmor_dir)
    if not args.dry_run:
        for rev in remove:
            target = root / rev
            if target.resolve().parent != root:
                continue
            shutil.rmtree(target)
            removed.append(rev)
        if apparmor.is_dir():
            installed = {p.name for p in root.iterdir() if p.is_dir()}
            for profile in apparmor.glob('patronus-*'):
                rev = profile.name[len('patronus-'):]
                if profile.is_file() and REV.match(rev) and rev not in installed:
                    drop_profile(profile, not args.no_unload)
                    profiles.append(rev)
    print(json.dumps({'kept': keep, 'removed': removed if not args.dry_run else [],
                      'wouldRemove': remove if args.dry_run else [], 'profilesRemoved': sorted(profiles),
                      'dryRun': args.dry_run}))


if __name__ == '__main__':
    main()
