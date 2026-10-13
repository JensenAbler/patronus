import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopControl } from '../src/patronus/desktop-control.js';
import { patronusTools } from '../src/patronus/schema.js';

function fixture({ fail, now = () => 0 } = {}) {
  const calls = [], pauses = [];
  const desktop = { display: ':73', healthy: () => true };
  const ctrl = new DesktopControl(desktop, {
    now, pause: async ms => pauses.push(ms),
    runInput: async (cmd, args, options) => {
      calls.push({cmd, args, options});
      if (fail) await fail(args, desktop);
    }
  });
  return {ctrl, calls, pauses, desktop};
}
const gesture = {x:100, y:100, toX:300, toY:200, points:[{x:200,y:250}], durationMs:400};

test('drag holds one left button along bounded screenshot-coordinate waypoints', async () => {
  const {ctrl,calls,pauses} = fixture();
  const result = await ctrl.drag(gesture);
  assert.deepEqual(calls[0].args, ['mousemove','150','150']);
  assert.deepEqual(calls[1].args, ['mousedown','1']);
  assert.deepEqual(calls.at(-1).args, ['mouseup','1']);
  assert.deepEqual(calls.at(-2).args, ['mousemove','450','300']);
  assert.ok(calls.some(c => JSON.stringify(c.args) === JSON.stringify(['mousemove','300','375'])));
  assert.equal(calls.filter(c => c.args[0] === 'mousedown').length, 1);
  assert.equal(calls.filter(c => c.args[0] === 'mouseup').length, 1);
  assert.ok(calls.every(c => c.cmd === 'xdotool' && c.options.display === ':73' && c.options.timeout <= 2000));
  assert.equal(pauses.reduce((a,b) => a+b,0), 400);
  assert.deepEqual(ctrl.cursor, {x:450,y:300});
  assert.deepEqual(result.dragged, {from:{x:100,y:100},to:{x:300,y:200},points:1,durationMs:400,button:'left'});
});

test('invalid complete drag paths never emit input', async () => {
  const cases = [
    {x:NaN}, {x:0.5}, {y:-1}, {toX:1280}, {toY:720}, {toX:undefined},
    {points:null}, {points:Array(33).fill({x:1,y:1})},
    {points:[null]}, {points:[{x:1,y:Infinity}]}, {points:[{x:2,y:720}]},
    {durationMs:199}, {durationMs:5001}, {durationMs:200.5}, {durationMs:'800'}
  ];
  for (const bad of cases) {
    const {ctrl,calls}=fixture();
    await assert.rejects(ctrl.drag({...gesture,...bad}), e => ['DESKTOP_DRAG_POLICY','DESKTOP_COORDINATE_POLICY'].includes(e.code));
    assert.equal(calls.length,0);
  }
});

test('movement failure still releases on original display after desktop health changes', async () => {
  let moves=0;
  const {ctrl,calls}=fixture({fail:async(args, desktop) => {
    if(args[0]==='mousemove' && ++moves===2) {
      desktop.display=':99'; desktop.healthy=()=>false;
      throw Object.assign(Error('synthetic failure'), {code:'DESKTOP_INPUT_FAILED'});
    }
  }});
  await assert.rejects(ctrl.drag(gesture), {code:'DESKTOP_INPUT_FAILED'});
  assert.deepEqual(calls.at(-1).args,['mouseup','1']);
  assert.equal(calls.at(-1).options.display,':73');
});

test('ambiguous button-down failure still attempts release', async () => {
  const {ctrl,calls}=fixture({fail:args => { if(args[0]==='mousedown') throw Error('down may have landed'); }});
  await assert.rejects(ctrl.drag(gesture), /down may have landed/);
  assert.deepEqual(calls.map(c=>c.args[0]),['mousemove','mousedown','mouseup']);
});

test('release failure is explicit and never reported as a successful drag', async () => {
  const {ctrl}=fixture({fail:args => {if(args[0]==='mouseup')throw Error('up failed');}});
  await assert.rejects(ctrl.drag(gesture), {code:'DESKTOP_DRAG_RELEASE_FAILED'});
});

test('overall deadline failure releases the held button', async () => {
  let time=0;
  const {ctrl,calls}=fixture({now:()=>time, fail:args=>{if(args[0]==='mousedown')time=6000;}});
  await assert.rejects(ctrl.drag(gesture), {code:'DESKTOP_INPUT_TIMEOUT'});
  assert.deepEqual(calls.at(-1).args,['mouseup','1']);
});

test('drag policy is available through the existing desktop schema', () => {
  const schema=patronusTools.patronus_desktop.schema;
  assert.equal(schema.parse({action:'drag',...gesture,idempotencyKey:'synthetic-drag-001'}).action,'drag');
  for(const bad of [{toX:1280},{toY:-1},{durationMs:10000},{points:Array(33).fill({x:1,y:1})}])
    assert.equal(schema.safeParse({action:'drag',...gesture,...bad,idempotencyKey:'synthetic-drag-001'}).success,false);
  assert.equal(schema.safeParse({action:'drag',...gesture,arbitraryCommand:'bad',idempotencyKey:'synthetic-drag-001'}).success,false);
});

test('non-left buttons are refused before any native input', async () => {
 const {ctrl,calls}=fixture();
 await assert.rejects(ctrl.drag({...gesture,button:'right'}),{code:'DESKTOP_BUTTON_POLICY'});
 assert.equal(calls.length,0);
});

test('desktop death or replacement stops movement but still releases the original display', async () => {
 for(const changed of ['health','display','session']) {
  const {ctrl,calls}=fixture({fail:(args,desktop)=>{
   if(args[0]==='mousedown') {
    if(changed==='health')desktop.healthy=()=>false;
    if(changed==='display')desktop.display=':88';
    if(changed==='session')desktop.startedAt='new-session';
   }
  }});
  await assert.rejects(ctrl.drag(gesture),{code:changed==='health'?'DESKTOP_NOT_RUNNING':'DESKTOP_SESSION_CHANGED'});
  assert.deepEqual(calls.map(c=>c.args[0]),['mousemove','mousedown','mouseup']);
  assert.equal(calls.at(-1).options.display,':73');
 }
});
