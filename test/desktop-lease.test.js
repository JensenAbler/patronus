import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopLease } from '../src/patronus/desktop-lease.js';

test('one reader gate excludes owner, agent and raw callers without revealing tokens', async t => {
  const lease=createDesktopLease();t.after(()=>lease.close());
  const owner=lease.acquire({kind:'owner'});
  assert.equal(owner.leaseId.length,43);
  assert.equal(JSON.stringify(lease.status()).includes(owner.leaseId),false);
  assert.throws(()=>lease.acquire({kind:'agent'}),{code:'DESKTOP_HUMAN_CONTROL'});
  await assert.rejects(lease.run(undefined,()=>assert.fail()),{code:'DESKTOP_HUMAN_CONTROL'});
  await assert.rejects(lease.run('x'.repeat(43),()=>assert.fail()),{code:'DESKTOP_CONTROL_LEASE_INVALID'});
  assert.equal(await lease.run(owner.leaseId,context=>{assert.equal(context.kind,'owner');context.assertActive();return 42;}),42);
  assert.equal(lease.release(owner).released,true);
  assert.equal(await lease.run(undefined,context=>context.kind),'raw');
  assert.equal(lease.status().held,false);
});
test('release aborts input but stays locked until native action settles',async t=>{
  const lease=createDesktopLease();t.after(()=>lease.close());
  const agent=lease.acquire({kind:'agent'});let finish,context;
  const running=lease.run(agent.leaseId,c=>{context=c;return new Promise(r=>finish=r);});
  await assert.rejects(lease.run(agent.leaseId,()=>assert.fail()),{code:'DESKTOP_BUSY'});
  assert.deepEqual(lease.release(agent),{released:false,draining:true});
  assert.equal(context.signal.aborted,true);
  assert.throws(()=>context.assertActive(),{code:'DESKTOP_CONTROL_RELEASED'});
  assert.throws(()=>lease.acquire({kind:'owner'}),{code:'DESKTOP_BUSY'});
  await assert.rejects(lease.run(undefined,()=>assert.fail()),{code:'DESKTOP_BUSY'});
  finish();await running;
  const next=lease.acquire({kind:'owner'});
  assert.throws(()=>lease.release(agent),{code:'DESKTOP_CONTROL_LEASE_INVALID'});
  lease.release(next);
});
test('expired leases drain in-flight work; no restart is needed after settlement',async t=>{
  let now=1700000000000;
  const lease=createDesktopLease({now:()=>now,ownerMs:1000,agentMs:100});t.after(()=>lease.close());
  const agent=lease.acquire({kind:'agent'});let finish,signal;
  const running=lease.run(agent.leaseId,c=>{signal=c.signal;return new Promise(r=>finish=r);});
  now+=101;
  assert.equal(lease.status().draining,true);assert.equal(signal.aborted,true);
  assert.throws(()=>lease.acquire({kind:'owner'}),{code:'DESKTOP_BUSY'});
  finish();await running;
  const owner=lease.acquire({kind:'owner'});now+=1001;
  assert.equal(lease.status().held,false);
  await assert.rejects(lease.run(owner.leaseId,()=>assert.fail()),{code:'DESKTOP_CONTROL_LEASE_INVALID'});
  assert.equal(await lease.run(undefined,()=>true),true);
});
test('raw action owns the gate until settlement, including rejection and close',async()=>{
  const lease=createDesktopLease();let finish;
  const running=lease.run(undefined,()=>new Promise(r=>finish=r));
  assert.throws(()=>lease.acquire({kind:'owner'}),{code:'DESKTOP_BUSY'});
  lease.close();
  assert.equal(lease.status().draining,true);
  await assert.rejects(lease.run(undefined,()=>assert.fail()),{code:'DESKTOP_CONTROL_CLOSED'});
  finish();await running;assert.equal(lease.status().held,false);
  const next=createDesktopLease();await assert.rejects(next.run(undefined,async()=>{throw Error('fixture');}),/fixture/);
  assert.equal(next.status().held,false);next.close();
});
test('invalid control requests fail without changing ownership',async t=>{
  const lease=createDesktopLease();t.after(()=>lease.close());
  for(const kind of ['raw','OWNER',undefined])assert.throws(()=>lease.acquire({kind}),{code:'DESKTOP_LEASE_POLICY'});
  assert.throws(()=>lease.release({leaseId:'invalid'}),{code:'DESKTOP_LEASE_POLICY'});
  await assert.rejects(lease.run('',()=>true),{code:'DESKTOP_LEASE_POLICY'});
  assert.equal(lease.status().held,false);
});

test('owner epoch survives lease release and changes only for successful owner takeover',async t=>{
 const lease=createDesktopLease();t.after(()=>lease.close());
 assert.equal(lease.status().ownerEpoch,0);
 const agent=lease.acquire({kind:'agent'});assert.equal(agent.ownerEpoch,0);
 assert.throws(()=>lease.acquire({kind:'owner'}),{code:'DESKTOP_BUSY'});
 assert.equal(lease.status().ownerEpoch,0);lease.release(agent);
 const owner=lease.acquire({kind:'owner'});assert.equal(owner.ownerEpoch,1);lease.release(owner);
 assert.equal(lease.status().ownerEpoch,1);
 await lease.run(undefined,()=>{});assert.equal(lease.status().ownerEpoch,1);
 const second=lease.acquire({kind:'owner'});assert.equal(second.ownerEpoch,2);lease.release(second);
});
