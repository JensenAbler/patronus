import { blockedRequest } from './browser-policy.js';
import { browserError } from './browser-errors.js';

export function addWarning(data,item) {
 const warnings=data.warnings??=[];
 if(warnings.length<50)warnings.push({severity:'warning',blocking:false,impact:'unknown',...item});
 else data.warningsOmitted=(data.warningsOmitted||0)+1;
}
export function requestWarning(req,code,reason) {
 return {...blockedRequest(req,reason),code,message:'A background request failed or was blocked. Inspect returned content before deciding whether it prevents the objective.'};
}
export function mainNavigation(req,page) {
 try{return req.isNavigationRequest()&&req.frame()===page?.mainFrame();}catch{return false;}
}
export function networkReason(text) {
 return browserError(new Error(String(text||'')),'subrequest').code;
}
