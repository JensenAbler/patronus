import test from 'node:test';
import assert from 'node:assert/strict';
import { locateX10Fields } from '../src/patronus/login.js';
const field=visible=>({isVisible:async()=>visible});
function formFixture(visibility,passwordVisible=true) {
 const entries=visibility.map(field);
 const password={count:async()=>1,isVisible:async()=>passwordVisible};
 const form={locator:selector=>selector==='input[type=password]'?password:{count:async()=>entries.length,nth:n=>entries[n]}};
 return {form,entries,password};
}
test('X10 uses its visible randomized username field and leaves hidden email fields untouched',async()=>{
 const {form,entries,password}=formFixture([true,false]);
 const found=await locateX10Fields(form);
 assert.equal(found.identifier,entries[0]);assert.equal(found.password,password);
});
test('ambiguous or invisible login fields fail before any paid solve or credential fill',async()=>{
 for(const values of [[true,true],[false,false],[]])await assert.rejects(locateX10Fields(formFixture(values).form),{code:'LOGIN_FORM_CHANGED'});
 await assert.rejects(locateX10Fields(formFixture([true],false).form),{code:'LOGIN_FORM_CHANGED'});
});
