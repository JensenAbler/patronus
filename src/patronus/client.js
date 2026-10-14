import http from 'node:http';

const unavailable = () => Object.assign(new Error('Patronus is unavailable; recover the existing job before retrying.'), { code: 'BACKEND_UNAVAILABLE' });
const codePattern = /^[A-Z][A-Z0-9_]+$/;

/** Internal Unix transport. A timeout never proves that native input has stopped. */
function request(path, payload, { socket = process.env.PATRONUS_SOCKET || '/run/patronus/api.sock', timeout = 35000, maxResponseBytes = 8000000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const req = http.request({ socketPath: socket, path, method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) { finish(unavailable()); res.destroy(); req.destroy(); }
        else chunks.push(chunk);
      });
      res.on('aborted', () => finish(unavailable()));
      res.on('error', () => finish(unavailable()));
      res.on('end', () => {
        if (settled) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(unavailable()); }
        if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') return finish(unavailable());
        if (!body.ok) return finish(Object.assign(new Error('Patronus could not complete this operation.'), {
          code: codePattern.test(body.error?.code || '') ? body.error.code : 'BACKEND_UNAVAILABLE'
        }));
        if (res.statusCode !== 200 || !Object.hasOwn(body, 'data')) return finish(unavailable());
        finish(null, body.data);
      });
    });
    timer = setTimeout(() => { finish(unavailable()); req.destroy(); }, timeout);
    req.on('error', () => finish(unavailable()));
    req.end(JSON.stringify(payload));
  });
}
export function patronusCall(action, args, { leaseId, ownerText, expectedDesktopStartedAt, ...options } = {}) {
  return request('/call', { action, args, ...(leaseId === undefined ? {} : { leaseId }),
    ...(ownerText === undefined ? {} : { ownerText }),
    ...(expectedDesktopStartedAt === undefined ? {} : { expectedDesktopStartedAt }) }, options);
}
export function patronusLease(action, args = {}, options = {}) {
  return request('/desktop-lease', { action, args }, options);
}
