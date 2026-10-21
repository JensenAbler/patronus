import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parseRoutes, routeFor, connectVia } from '../src/patronus/network.js';

test('parseRoutes accepts loopback CONNECT proxies and rejects anything else', () => {
  assert.deepEqual(parseRoutes(''), []);
  assert.deepEqual(parseRoutes(undefined), []);
  assert.deepEqual(parseRoutes('BenefitsCal.com, .ca.gov. =http://127.0.0.1:1056'),
    [{ hosts: ['benefitscal.com', 'ca.gov'], host: '127.0.0.1', port: 1056 }]);
  assert.equal(parseRoutes('a.com=http://127.0.0.1:1;b.com=http://localhost:2').length, 2);
  for (const bad of ['a.com', '=http://127.0.0.1:1', 'a.com=http://10.0.0.1:1056', 'a.com=https://127.0.0.1:1056',
    'a.com=http://127.0.0.1', 'a b.com=http://127.0.0.1:1', 'a.com=not a url'])
    assert.throws(() => parseRoutes(bad), { code: 'ROUTE_CONFIG' }, bad);
});

test('routeFor matches a host and its subdomains only', () => {
  const routes = parseRoutes('benefitscal.com=http://127.0.0.1:1056');
  assert.ok(routeFor('benefitscal.com', routes));
  assert.ok(routeFor('API.BenefitsCal.com.', routes));
  assert.equal(routeFor('notbenefitscal.com', routes), null);
  assert.equal(routeFor('benefitscal.com.evil.net', routes), null);
  assert.equal(routeFor('example.com', []), null);
});

function fakeProxy(t, reply) {
  const seen = [];
  const server = net.createServer(socket => {
    let buf = '';
    socket.on('data', function first(chunk) {
      buf += chunk;
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', first);
      seen.push(buf.slice(0, end).split('\r\n')[0]);
      reply(socket, buf.slice(end + 4));
    });
  });
  t.after(() => server.close());
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen })));
}

const echo = (socket, rest) => { socket.write('HTTP/1.1 200 Connection established\r\n\r\nhello'); if (rest) socket.write(rest); socket.pipe(socket); };

test('connectVia tunnels through CONNECT and keeps bytes sent with the 200', async t => {
  const { port, seen } = await fakeProxy(t, echo);
  const socket = await connectVia({ host: '127.0.0.1', port }, '93.184.216.34', 443);
  t.after(() => socket.destroy());
  socket.write('ping');
  let got = '';
  // connectVia hands back a paused socket so nothing is lost before it is piped.
  await new Promise(resolve => { socket.on('data', chunk => { got += chunk; if (got === 'helloping') resolve(); }); socket.resume(); });
  assert.deepEqual(seen, ['CONNECT 93.184.216.34:443 HTTP/1.1']);
});

test('connectVia brackets IPv6 targets', async t => {
  const { port, seen } = await fakeProxy(t, echo);
  const socket = await connectVia({ host: '127.0.0.1', port }, '2606:4700::1', 443);
  socket.destroy();
  assert.deepEqual(seen, ['CONNECT [2606:4700::1]:443 HTTP/1.1']);
});

test('connectVia fails closed when the proxy refuses or is unavailable', async t => {
  const { port } = await fakeProxy(t, socket => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  await assert.rejects(connectVia({ host: '127.0.0.1', port }, '93.184.216.34', 443), { code: 'ROUTE_REFUSED' });
  const closed = net.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const dead = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  await assert.rejects(connectVia({ host: '127.0.0.1', port: dead }, '93.184.216.34', 443), { code: 'ROUTE_UNAVAILABLE' });
});
