import test from 'node:test';
import assert from 'node:assert/strict';
import { setX10Remember } from '../src/patronus/login.js';
test('hidden X10 remember checkbox uses its visible label and confirms the checked state',async()=>{
 let checked=false,clicked=0;
 const checkbox={count:async()=>1,isChecked:async()=>checked,isVisible:async()=>false,getAttribute:async()=> 'remember',check:async()=>assert.fail('Hidden checkbox must not be checked directly')};
 const label={count:async()=>1,isVisible:async()=>true,evaluate:async fn=>fn({click:()=>{clicked++;checked=true;}})};
 const form={locator:s=>s==='input[type=checkbox]'?checkbox:label};
 await setX10Remember(form);assert.equal(clicked,1);assert.equal(checked,true);
 await setX10Remember(form);assert.equal(clicked,1);
});
test('unexpected hidden checkbox fails without clicking an unrelated label',async()=>{
 const checkbox={count:async()=>1,isChecked:async()=>false,isVisible:async()=>false,getAttribute:async()=> 'other'};
 const label={click:async()=>assert.fail()};
 await assert.rejects(setX10Remember({locator:s=>s==='input[type=checkbox]'?checkbox:label}),{code:'LOGIN_REMEMBER_UNAVAILABLE'});
});
