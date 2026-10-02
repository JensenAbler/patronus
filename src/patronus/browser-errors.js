import { fault } from './network.js';

// Inspect exception text locally; expose only stable, credential-free codes.
export function browserError(error,stage,signal) {
 if(signal?.aborted)return fault(signal.reason?.code||'CANCELLED');
 if(/^[A-Z][A-Z0-9_]+$/.test(error?.code||''))return fault(error.code);
 const text=String(error?.message||'');
 if(stage==='launch')return fault('BROWSER_LAUNCH_FAILED');
 if(error?.name==='TimeoutError'||/Timeout \d+ms exceeded/.test(text))return fault('BROWSER_TIMEOUT');
 const net=text.match(/\bnet::(ERR_[A-Z0-9_]+)\b/)?.[1];
 if(net==='ERR_HTTP2_PROTOCOL_ERROR')return fault('BROWSER_HTTP2_ERROR');
 if(net==='ERR_NAME_NOT_RESOLVED')return fault('BROWSER_DNS_ERROR');
 if(net&&/CERT_|SSL_/.test(net))return fault('BROWSER_TLS_ERROR');
 if(net)return fault('BROWSER_NETWORK_ERROR');
 if(/Target (page, context or browser|closed)|has been closed/i.test(text))return fault('BROWSER_CLOSED');
 return fault('BROWSER_RETRIEVAL_ERROR');
}
