export function handler(request, response) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(request.url === '/healthz' ? { ok: true } : { message: 'patronus' }));
}
