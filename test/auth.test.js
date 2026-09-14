import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { generateKeyPair, exportJWK, importJWK, SignJWT } from 'jose';
import { createAuth } from '../src/auth.js';
import { serve } from '../src/patronus/server.js';
import { patronusCall } from '../src/patronus/client.js';
import { createApp } from '../src/gateway.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function fixture(t, { integrated = false, codingEnabled = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'patronus-auth-test-'));
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(privateKey), kid: 'test-key', use: 'sig', alg: 'RS256' };
  const password = 'fixture-owner-password';
  const salt = randomBytes(16);
  const passwordHash = `scrypt$${salt.toString('base64url')}$${scryptSync(password, salt, 64).toString('base64url')}`;
  const app = express();
  let auth;
  let service;
  let reader;
  if (integrated) app.use((req, res, next) => service.app(req, res, next));
  else app.use('/oauth', (req, res, next) => auth.router(req, res, next));
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const prefix = integrated ? '/patronus' : '';
  const issuer = `${origin}${prefix}/oauth`;
  const resource = `${origin}${prefix}/mcp`;
  const options = { issuer, resourceUrl: resource, passwordHash, jwks: { keys: [jwk] }, cookieKeys: ['fixture-cookie-signing-key-that-is-very-long'], dataDirectory: directory, allowLoopback: true, codingEnabled };
  if (integrated) {
    reader=await serve({root:join(directory,'reader'),socket:join(directory,'reader.sock')});
    service = await createApp({call:(action,args)=>patronusCall(action,args,{socket:join(directory,'reader.sock')}), baseUrl: `${origin}${prefix}`, dataDirectory: directory, allowLoopback: true, auth: options });
    auth = service.auth;
  } else auth = await createAuth(options);
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); if (service) await service.close(); else auth.close(); if(reader)await reader.close(); await rm(directory, { recursive: true, force: true }); });
  const request = (path, init) => fetch(new URL(path, origin), { redirect: 'manual', ...init });
  async function register(extra = {}) {
    const response = await request(`${prefix}/oauth/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Probe test client', redirect_uris: ['https://client.example/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...extra }) });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return body;
  }
  async function flow(client, { passwordOverride, missingCsrf = false, originOverride, scope = 'openid offline_access patronus:read' } = {}) {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const cookies = new Map();
    async function browser(url, init = {}) {
      const headers = { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...init.headers };
      const response = await fetch(url, { redirect: 'manual', ...init, headers });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('='); cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    }
    const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', scope, resource, code_challenge: challenge, code_challenge_method: 'S256', state: 'test-state', prompt: 'consent' });
    let response = await browser(`${issuer}/auth?${params}`);
    for (let turn = 0; turn < 12; turn++) {
      if (response.status >= 300 && response.status < 400) {
        const target = new URL(response.headers.get('location'), issuer);
        if (target.origin !== origin) {
          assert.equal(target.searchParams.get('error'), null, target.href);
          assert.equal(target.searchParams.get('iss'), issuer);
          assert.equal(target.searchParams.get('state'), 'test-state');
          return { code: target.searchParams.get('code'), verifier };
        }
        response = await browser(target.href);
      } else if (response.status === 200) {
        // The browser's native form submission must retain its real Origin header.
        assert.equal(response.headers.get('referrer-policy'), 'strict-origin');
        assert.ok(response.headers.get('content-security-policy').includes("form-action 'self' " + new URL(client.redirect_uris[0]).origin + ';'));
        const html = await response.text();
        assert.match(html, /<title>Patronus<\/title>/);
        assert.match(html, /<h1>(Sign in to|Connect) Patronus<\/h1>/);
    
        const action = html.match(/<form method="post" action="([^"]+)"/)?.[1];
        const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
        assert.ok(action && csrf, html);
        response = await browser(action, { method: 'POST', headers: { origin: originOverride ?? origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: missingCsrf ? 'wrong' : csrf, action: 'allow', ...(html.includes('name="password"') ? { password: passwordOverride ?? password } : {}) }) });
        if (passwordOverride || missingCsrf || originOverride) return response;
      } else {
        assert.fail(`Unexpected authorization HTTP ${response.status}: ${await response.text()}`);
      }
    }
    assert.fail('Authorization did not complete');
  }
  async function exchange(client, grant, extra = {}) {
    const body = { grant_type: 'authorization_code', client_id: client.client_id, code: grant.code, code_verifier: grant.verifier, redirect_uri: client.redirect_uris[0], resource, ...extra };
    return request(`${prefix}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  }
  return { origin, issuer, resource, jwk, request, register, flow, exchange, get auth() { return auth; }, async restart() { auth.close(); auth = await createAuth(options); } };
}

test('OAuth discovery, owner login, PKCE, JWT verification and persistent rotating refresh', async (t) => {
  const f = await fixture(t);
  const discovery = await (await f.request('/oauth/.well-known/openid-configuration')).json();
  assert.equal(discovery.issuer, f.issuer);
  assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
  assert.equal(discovery.authorization_response_iss_parameter_supported, true);
  const client = await f.register();
  const grant = await f.flow(client, { scope: 'patronus:read offline_access' });
  const response = await f.exchange(client, grant);
  const token = await response.json();
  assert.equal(response.status, 200, JSON.stringify(token));
  assert.ok(token.refresh_token);
  const verified = await f.auth.verifyAccessToken(token.access_token);
  assert.equal(verified.extra.subject, 'jensen');
  assert.deepEqual(verified.scopes, ['patronus:read']);
  assert.equal(verified.clientId, client.client_id);
  await f.restart();
  assert.equal((await f.auth.verifyAccessToken(token.access_token)).extra.subject, 'jensen');
  const refresh = await f.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token.refresh_token, resource: f.resource }) });
  const refreshed = await refresh.json();
  assert.equal(refresh.status, 200, JSON.stringify(refreshed));
  assert.notEqual(refreshed.refresh_token, token.refresh_token);
  assert.equal((await f.auth.verifyAccessToken(refreshed.access_token)).extra.subject, 'jensen');
  const replay = await f.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token.refresh_token, resource: f.resource }) });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_grant');
});

test('owner password, CSRF and form origin are enforced', async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  assert.equal((await f.flow(client, { passwordOverride: 'incorrect' })).status, 401);
  assert.equal((await f.flow(client, { missingCsrf: true })).status, 403);
  assert.equal((await f.flow(client, { originOverride: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.flow(client, { originOverride: 'null' })).status, 403);
});

test('PKCE code verifier and confidential client secret are checked', async (t) => {
  const f = await fixture(t);
  const publicClient = await f.register();
  const publicGrant = await f.flow(publicClient);
  const failedPkce = await f.exchange(publicClient, publicGrant, { code_verifier: randomBytes(32).toString('base64url') });
  assert.equal(failedPkce.status, 400);
  assert.equal((await failedPkce.json()).error, 'invalid_grant');
  const privateClient = await f.register({ token_endpoint_auth_method: 'client_secret_post' });
  const privateGrant = await f.flow(privateClient);
  const failedSecret = await f.exchange(privateClient, privateGrant, { client_secret: 'wrong-secret' });
  assert.equal((await failedSecret.json()).error, 'invalid_client');
  const validSecret = await f.exchange(privateClient, privateGrant, { client_secret: privateClient.client_secret });
  assert.equal(validSecret.status, 200, await validSecret.text());
});

test('access token verification rejects invalid signature, issuer, subject, audience, expiry and scope', async (t) => {
  const f = await fixture(t);
  const key = await importJWK(f.jwk, 'RS256');
  const claims = { iss: f.issuer, aud: f.resource, sub: 'jensen', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, scope: 'patronus:read', client_id: 'test-client' };
  async function sign(overrides = {}, signingKey = key) { return new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'at+jwt' }).sign(signingKey); }
  for (const override of [{ iss: 'https://wrong.example' }, { sub: 'someone-else' }, { aud: 'https://wrong.example' }, { aud: [f.resource, 'https://wrong.example'] }, { exp: 1 }, { scope: 'unrelated' }, { scope: 'praxis:code' }, { iss: f.origin+'/praxis/oauth' }]) {
    await assert.rejects(f.auth.verifyAccessToken(await sign(override)));
  }
  const other = await generateKeyPair('RS256');
  await assert.rejects(f.auth.verifyAccessToken(await sign({}, other.privateKey)));
  await assert.rejects(f.auth.verifyAccessToken('invalid-token'));
});

test('registration rejects unsafe callback and remote metadata inputs', async (t) => {
  const f = await fixture(t);
  for (const fields of [{ redirect_uris: ['http://untrusted.example/callback'] }, { redirect_uris: ['https://user:pass@client.example/callback'] }, { redirect_uris: ['https://client.example/callback#fragment'] }, { redirect_uris: ['https://client.example/callback'], jwks_uri: 'http://127.0.0.1/private' }]) {
    const response = await f.request('/oauth/reg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) });
    assert.equal(response.status, 400, await response.text());
  }
});

test('Patronus endpoint publishes discovery aliases and serves MCP only after real OAuth', async (t) => {
  const f = await fixture(t, { integrated: true });
  const metadata = await (await f.request('/.well-known/oauth-authorization-server/patronus/oauth')).json();
  assert.equal(metadata.issuer, f.issuer);
  assert.equal((await (await f.request('/.well-known/openid-configuration/patronus/oauth')).json()).issuer, f.issuer);
  const resourceMetadata = await (await f.request('/.well-known/oauth-protected-resource/patronus/mcp')).json();
  assert.equal(resourceMetadata.resource, f.resource);
  assert.equal(resourceMetadata.resource_name, 'Patronus');
  assert.deepEqual(resourceMetadata.authorization_servers, [f.issuer]);
  const unauthenticated = await f.request('/patronus/mcp');
  assert.equal(unauthenticated.status, 401);
  assert.ok(unauthenticated.headers.get('www-authenticate').includes(`${f.origin}/.well-known/oauth-protected-resource/patronus/mcp`));
  const rejected = await f.request('/patronus/mcp', { headers: { authorization: 'Bearer invalid-token' } });
  assert.equal(rejected.status, 401);
  assert.match(rejected.headers.get('www-authenticate'), /invalid_token/);
  const registration = await f.register();
  const grant = await f.flow(registration, { scope: 'patronus:read offline_access' });
  const response = await f.exchange(registration, grant);
  const token = await response.json();
  assert.equal(response.status, 200, JSON.stringify(token));
  const client = new Client({ name: 'authenticated-probe-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(f.resource), { requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } } });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'Patronus');
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'patronus_capabilities'));
    const capabilities = await client.callTool({ name: 'patronus_capabilities', arguments: {} });
    assert.equal(capabilities.structuredContent.ok, true);
    assert.equal(capabilities.structuredContent.name, 'Patronus');
    assert.equal(listed.tools.length,7);
    assert.ok(listed.tools.every(tool=>tool.name.startsWith('patronus_')));
    const denied=await client.callTool({name:'patronus_start',arguments:{urls:['http://127.0.0.1/private'],rendering:'http',idempotencyKey:'private-address-denied'}});
    assert.equal(denied.structuredContent.ok,true);
    let final;
    for(let n=0;n<30;n++){final=await client.callTool({name:'patronus_status',arguments:{jobId:denied.structuredContent.jobId}});if(final.structuredContent.state==='failed')break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(final.structuredContent.state,'failed');
    assert.equal(final.structuredContent.pages.length,0);
    assert.equal(final.structuredContent.obstacles[0].code,'NETWORK_POLICY');
  } finally { await client.close(); }
  assert.equal(metadata.authorization_endpoint, `${f.issuer}/auth`);
});

test('real browser follows consent redirect and completes authenticated MCP', { skip: !process.env.PATRONUS_TEST_CHROMIUM }, async (t) => {
  const { chromium } = await import('playwright');
  const f = await fixture(t, { integrated: true });
  const registration = await f.register();
  const browser = await chromium.launch({ executablePath: process.env.PATRONUS_TEST_CHROMIUM, headless: true, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const callback = registration.redirect_uris[0];
  let completed;
  await page.route(callback + '**', async route => {
    completed = new URL(route.request().url());
    await route.fulfill({ status: 200, body: 'Callback reached' });
  });
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({ client_id: registration.client_id, redirect_uri: callback, response_type: 'code', scope: 'openid patronus:read', resource: f.resource, state: 'browser-test', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  await page.goto(f.issuer + '/auth?' + params);
  await page.locator('input[name=password]').fill('fixture-owner-password');
  await page.locator('button[value=allow]').click();
  await page.getByText('Allow the permissions described above?', { exact: true }).waitFor();
  await page.locator('button[value=allow]').click();
  await page.waitForURL(callback + '**', { timeout: 5000 });
  assert.equal(completed.searchParams.get('error'), null);
  assert.equal(completed.searchParams.get('state'), 'browser-test');
  const response = await f.exchange(registration, { code: completed.searchParams.get('code'), verifier });
  assert.equal(response.status, 200);
  const token = await response.json();
  const client = new Client({ name: 'browser-regression', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(f.resource), { requestInit: { headers: { Authorization: 'Bearer ' + token.access_token } } }));
    assert.equal((await client.listTools()).tools.length, 7);
    assert.equal((await client.callTool({ name: 'patronus_capabilities', arguments: {} })).structuredContent.ok, true);
  } finally { await client.close(); }
});
