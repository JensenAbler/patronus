import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
test("extension staging is immutable, limited, and idempotent in an isolated temporary directory",()=>{
  const code = `
import importlib.util,pathlib,tempfile,os
spec=importlib.util.spec_from_file_location("stage","scripts/stage-verification-diagnostic.py")
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as tmp:
 base=pathlib.Path(tmp)/"diagnostics"
 previous_umask=os.umask(0o077)
 try: target=module.stage(".", "a"*40, base=base)
 finally: os.umask(previous_umask)
 assert base.stat().st_mode & 0o777 == 0o750
 os.chmod(base,0o700)
 assert module.stage(".", "a"*40, base=base) == target
 assert base.stat().st_mode & 0o777 == 0o750
 assert set(p.name for p in target.iterdir()) == set(module.FILES)
 assert module.stage(".", "a"*40, base=base) == target
 assert (target/"manifest.json").stat().st_mode & 0o777 == 0o640
 assert target.stat().st_mode & 0o777 == 0o750
 try: module.stage(".", "bad", base=base)
 except ValueError: pass
 else: raise AssertionError("bad revision accepted")
 (target/"core.js").write_text("changed synthetic fixture")
 try: module.stage(".", "a"*40, base=base)
 except ValueError: pass
 else: raise AssertionError("modified installation accepted")
print("isolated staging passed")
`;
  assert.match(execFileSync("python3",["-c",code],{encoding:"utf8"}),/isolated staging passed/);
});
