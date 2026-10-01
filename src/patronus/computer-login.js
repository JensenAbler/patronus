import { fault } from './network.js';
import { locateX10Fields, diagnoseX10Error, classifyX10Error, redactLoginText } from './login.js';
import { solvePageChallenge } from './challenges.js';

// Coordinates come from the agent's most recent screenshot. DOM access validates
// where a secret may go; it never selects or submits the interactive target.
export async function computerLogin({engine,d,args,signal,page,credentials,state,diagnostic,capture,authenticated,success,mark}) {
 const viewport=page.viewportSize()||{width:1100,height:900};
 const control=d.computerUse={state:'awaiting-action',viewport,commands:[],
  screenshotArtifactId:diagnostic.screenshots?.at(-1)?.artifactId||null};
 let done=false,result,failure;
 const snapshot=async label=>{
  const item=await capture(label);
  control.screenshotArtifactId=item?.artifactId||null;
  if(!control.screenshotArtifactId)throw fault('COMPUTER_SCREENSHOT_UNAVAILABLE');
  engine.save(d);
 };
 const position=a=>{
  if(!Number.isInteger(a.x)||!Number.isInteger(a.y)||a.x<0||a.y<0||a.x>=viewport.width||a.y>=viewport.height)throw fault('COMPUTER_COORDINATE_POLICY');
 };
 const loginForm=async()=>{
  if(page.url()!=='https://x10hosting.com/login')throw fault('LOGIN_ORIGIN_MISMATCH');
  const form=page.locator('form').filter({has:page.locator('input[type=password]')});
  if(await form.count()!==1)throw fault('LOGIN_FORM_CHANGED');
  const action=await form.getAttribute('action');
  if(new URL(action||page.url(),page.url()).href!=='https://x10hosting.com/login')throw fault('LOGIN_FORM_CHANGED');
  return form;
 };
 const handler=async a=>{
  if(done)throw fault('COMPUTER_SESSION_ENDED');
  if(signal.aborted)throw signal.reason;
  if(a.action!=='snapshot'&&a.screenshotArtifactId!==control.screenshotArtifactId)throw fault('COMPUTER_STALE_SCREENSHOT');
  if(args.sessionOnly&&['credential','solveCaptcha','submit'].includes(a.action))throw fault('SESSION_PROBE_METHOD_POLICY');
  mark('COMPUTER_'+a.action.toUpperCase());
  try {
   if(a.action==='click') {position(a);state.challengeArmed=true;await page.mouse.click(a.x,a.y);}
   else if(a.action==='credential') {
    position(a);
    if(!['email','password'].includes(a.field))throw fault('COMPUTER_CREDENTIAL_POLICY');
    const form=await loginForm(),fields=await locateX10Fields(form);
    const field=a.field==='email'?fields.identifier:fields.password;
    if(!await field.evaluate((el,p)=>document.elementFromPoint(p.x,p.y)===el,{x:a.x,y:a.y}))throw fault('COMPUTER_CREDENTIAL_TARGET');
    state.credentialsFilled=true;
    await page.mouse.click(a.x,a.y);
    if(!await field.evaluate(el=>document.activeElement===el))throw fault('COMPUTER_CREDENTIAL_TARGET');
    // The request names a credential reference, never its secret value.
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(credentials[a.field]);
   }else if(a.action==='press') {
    if(!['Tab','Shift+Tab','Escape','ArrowDown','ArrowUp','Backspace'].includes(a.key))throw fault('COMPUTER_KEY_POLICY');
    await page.keyboard.press(a.key);
   }else if(a.action==='solveCaptcha') {
    if(state.credentialsFilled)throw fault('COMPUTER_SOLVE_BEFORE_CREDENTIALS');
    if(!(await solvePageChallenge(engine,page,d,args,signal,state.solverState,{callbacks:true})))throw fault('VERIFICATION_NOT_COMPLETED');
   }else if(a.action==='submit') {
    position(a);
    if(state.submitted)throw fault('LOGIN_ALREADY_SUBMITTED');
    const form=await loginForm();
    const target=await form.evaluate((f,p)=>{
     const el=document.elementFromPoint(p.x,p.y)?.closest('button,input');
     return !!el&&el.form===f&&(el instanceof HTMLButtonElement?el.type==='submit':el.type==='submit');
    },{x:a.x,y:a.y});
    if(!target)throw fault('COMPUTER_SUBMIT_TARGET');
    // Arm only the deliberate screenshot-driven submit click.
    state.submitArmed=true;
    await page.mouse.click(a.x,a.y);
   }else if(!['snapshot','finish'].includes(a.action))throw fault('COMPUTER_ACTION_POLICY');
   await page.waitForTimeout(500);
   await snapshot('COMPUTER_'+a.action.toUpperCase());
   const auth=await authenticated();
   if(new URL(page.url()).pathname==='/error') {
    diagnostic.errorMessage=redactLoginText(await page.locator('body').innerText({timeout:2000}),[credentials.email,credentials.password]);
    diagnostic.serverDiagnosis=diagnoseX10Error(diagnostic.errorMessage);
    engine.save(d);
    failure=fault(classifyX10Error(diagnostic));done=true;throw failure;
   }
   if(auth) {result=success(state.submitted,'COMPUTER_AUTHENTICATED');done=true;}
   else if(a.action==='finish') {
    result={url:page.url(),route:'browser',title:'X10 computer-use session',
     login:{authenticated:false,freshLogin:false,outcome:'COMPUTER_SESSION_ENDED_UNAUTHENTICATED'},
     coverage:{scope:'Screenshot-driven browser session; no authenticated portal verified.'}};
    done=true;
   }
   control.state=done?'ended':'awaiting-action';engine.save(d);
   return {state:control.state,screenshotArtifactId:control.screenshotArtifactId,viewport,authentication:diagnostic.authentication,credentialSubmissionObserved:state.submitted};
  }catch(e) {
   if(state.submitted&&new URL(page.url()).pathname==='/error'){failure=e;done=true;}
   throw e;
  }finally {state.submitArmed=false;state.challengeArmed=false;}
 };
 if(!control.screenshotArtifactId)await snapshot('COMPUTER_READY');
 engine.computerSessions.set(d.jobId,{handler,busy:false,data:d});
 engine.save(d);
 try {
  while(!done) {
   if(signal.aborted)throw signal.reason;
   await new Promise(r=>setTimeout(r,200));
  }
  if(failure)throw failure;
  Object.assign(diagnostic,{credentialSubmissionObserved:state.submitted,submittedAt:state.submittedAt||null});
  return result;
 }finally {
  control.state='ended';engine.save(d);
  engine.computerSessions.delete(d.jobId);
 }
}
