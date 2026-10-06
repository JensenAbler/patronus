import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { startProxy } from '../src/patronus/network.js';

// Keep real loopback client sockets, but replace only the public upstream
// transport. No external network or production timeout change is needed.
const connect = net.connect.bind(net);
class Upstream extends Duplex {
  _read() {}
  _write(_chunk, _encoding, done) { done(); }
  setTimeout(milliseconds, callback) {
    this.timeoutMilliseconds = milliseconds;
    this.once('timeout', callback);
    return this;
  }
}
async function fixture(t) {
  const upstreams = [], clients = [];
  t.mock.method(net, 'connect', options => {
    assert.deepEqual(options, {host:'1.1.1.1',port:443});
    const socket = new Upstream();
    upstreams.push(socket);
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
  const proxy = await startProxy({maxBytes:1000000});
  t.after(() => {
    for (const socket of clients) socket.destroy();
    proxy.close();
  });
  return {
    async tunnel() {
      const client = connect({host:'127.0.0.1',port:Number(new URL(proxy.url).port)});
      clients.push(client);
      const connected = once(client, 'connect', {signal:AbortSignal.timeout(1000)});
      await connected;
      const response = once(client, 'data', {signal:AbortSignal.timeout(1000)});
      client.write('CONNECT 1.1.1.1:443 HTTP/1.1\r\nHost: 1.1.1.1:443\r\n\r\n');
      assert.equal((await response)[0].toString(), 'HTTP/1.1 200 Connection Established\r\n\r\n');
      return {client,upstream:upstreams.at(-1)};
    }
  };
}

test('CONNECT idle timeout closes the client and permits a fresh tunnel', async t => {
  const proxy = await fixture(t);
  const {client,upstream} = await proxy.tunnel();
  assert.equal(upstream.timeoutMilliseconds, 30000);
  const closed = once(client, 'close', {signal:AbortSignal.timeout(1000)});
  upstream.emit('timeout');
  await closed;
  assert.equal(client.destroyed, true);
  assert.equal(upstream.destroyed, true);
  const fresh = await proxy.tunnel();
  assert.equal(fresh.client.destroyed, false);
  assert.equal(fresh.upstream.destroyed, false);
});

test('CONNECT upstream close without an error closes the client', async t => {
  const proxy = await fixture(t);
  const {client,upstream} = await proxy.tunnel();
  const closed = once(client, 'close', {signal:AbortSignal.timeout(1000)});
  upstream.destroy();
  await closed;
  assert.equal(client.destroyed, true);
});

test('CONNECT upstream errors still close both tunnel sockets', async t => {
  const proxy = await fixture(t);
  const {client,upstream} = await proxy.tunnel();
  const closed = once(client, 'close', {signal:AbortSignal.timeout(1000)});
  upstream.destroy(new Error('test upstream failure'));
  await closed;
  assert.equal(client.destroyed, true);
  assert.equal(upstream.destroyed, true);
});
