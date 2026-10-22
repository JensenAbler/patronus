import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Execute only the AST-selected pruning conditional with fake subprocesses.
// Never execute the installer, touch installed releases, or load AppArmor.
const probe=String.raw`
import ast,json,pathlib,sys,types
source_text=pathlib.Path('scripts/install-patronus.py').read_text()
tree=ast.parse(source_text)
nodes=[n for n in tree.body if isinstance(n,ast.If) and 'PATRONUS_SKIP_PRUNE' in ast.unparse(n.test)]
assert len(nodes)==1
node=nodes[0]
apparmor=[n for n in tree.body if isinstance(n,ast.If) and '/sys/module/apparmor/parameters/enabled' in ast.unparse(n.test)]
assert len(apparmor)==1 and apparmor[0].end_lineno<node.lineno
assert "run('apparmor_parser', '-r', str(policy_path))" in ast.unparse(apparmor[0])
assert "systemctl" not in ast.unparse(node)
calls=[]
def run(*args,**kwargs):
 calls.append({'args':args[0],'kwargs':kwargs})
 return types.SimpleNamespace(returncode=0,stdout='{"removed":["old-release"]}',stderr='')
env={} if sys.argv[1]=='unset' else {'PATRONUS_SKIP_PRUNE':sys.argv[1]}
scope=dict(os=types.SimpleNamespace(environ=env),subprocess=types.SimpleNamespace(run=run),sys=sys,json=json,
 source=pathlib.Path('/fixture/source'),revision='a'*40,unit_path=pathlib.Path('/fixture/unit'),gateway_path=pathlib.Path('/fixture/gateway'))
exec(compile(ast.Module(body=[node],type_ignores=[]),'<isolated-prune-branch>','exec'),scope)
print(json.dumps({'calls':calls,'pruned':scope['pruned']}))
`;
function inspect(value){return JSON.parse(execFileSync('python3',['-c',probe,value],{encoding:'utf8'}));}
test('explicit PATRONUS_SKIP_PRUNE=1 performs no pruning and preserves the security installation path',()=>{
  const r=inspect('1');
  assert.deepEqual(r.calls,[]);
  assert.deepEqual(r.pruned,{skipped:true,reason:'PATRONUS_SKIP_PRUNE'});
});
test('unset or non-1 retention option preserves existing pruning behavior',()=>{
  for(const value of ['unset','0','true','']){
    const r=inspect(value);
    assert.equal(r.calls.length,1);
    assert.equal(r.calls[0].args[1],'/fixture/source/scripts/prune-releases.py');
    assert.deepEqual(r.pruned,{removed:['old-release']});
  }
});
