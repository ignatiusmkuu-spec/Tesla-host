'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const adminFunction = require('../api/admin');

const TEST_HEROKU_KEY = 'test-only-vercel-heroku-key';
const TEST_ADMIN_PASSWORD = 'test-only-vercel-admin-password';
const TEST_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
let originalEnv;
let originalFetch;
let outbound = [];

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function makeRequest(route, { method = 'GET', origin, body, queryRoute = route } = {}) {
  const query = new URLSearchParams();
  if (queryRoute !== null) query.set('route', queryRoute);
  return {
    method,
    url: `/api/admin?${query.toString()}`,
    query: queryRoute === null ? {} : { route: queryRoute },
    headers: {
      host: 'tesla-host.vercel.app',
      'x-forwarded-proto': 'https',
      authorization: `Basic ${Buffer.from(`admin:${TEST_ADMIN_PASSWORD}`).toString('base64')}`,
      ...(origin ? { origin } : {}),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {})
    },
    socket: { remoteAddress: '203.0.113.8', encrypted: false },
    ...(body === undefined ? {} : { body })
  };
}

function makeResponse() {
  return {
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
      this.finished = true;
    }
  };
}

before(() => {
  originalEnv = {
    HEROKU_API_KEY: process.env.HEROKU_API_KEY,
    TESLA_HOST_ADMIN_PASSWORD: process.env.TESLA_HOST_ADMIN_PASSWORD,
    NODE_ENV: process.env.NODE_ENV
  };
  originalFetch = global.fetch;
  process.env.HEROKU_API_KEY = TEST_HEROKU_KEY;
  process.env.TESLA_HOST_ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
  process.env.NODE_ENV = 'production';
  outbound = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    outbound.push({ url: url.href, method: options.method || 'GET', headers: options.headers || {} });
    if (url.origin === 'https://api.heroku.com' && url.pathname === '/account') {
      return jsonResponse({ id: 'private-account-id', email: 'private@example.invalid' });
    }
    if (url.origin === 'https://api.github.com') {
      if (url.pathname === '/repos/sample-owner/sample-bot') {
        return jsonResponse({ private: false, default_branch: 'main' });
      }
      if (url.pathname === '/repos/sample-owner/sample-bot/commits') {
        return jsonResponse([{ sha: TEST_COMMIT_SHA }]);
      }
      if (url.pathname === '/repos/sample-owner/sample-bot/contents/app.json') {
        const manifest = { name: 'Vercel fixture', env: { DEV: { required: true }, SESSION: { required: true } } };
        return jsonResponse({
          encoding: 'base64',
          content: Buffer.from(JSON.stringify(manifest)).toString('base64')
        });
      }
    }
    throw new Error('Unexpected outbound request in Vercel Function test');
  };
});

after(() => {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('Vercel rewrite query dispatches the protected account route safely', async () => {
  const request = makeRequest('account');
  const response = makeResponse();
  await adminFunction(request, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { connected: true });
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(outbound.at(-1).headers.Authorization, `Bearer ${TEST_HEROKU_KEY}`);
  assert.doesNotMatch(response.body, /private@example|private-account-id|test-only-vercel-heroku-key/);
});

test('Vercel route handler rejects malformed paths without calling Heroku', async () => {
  const beforeCalls = outbound.length;
  const request = makeRequest('account', { queryRoute: '../../account' });
  const response = makeResponse();
  await adminFunction(request, response);
  assert.equal(response.statusCode, 404);
  assert.equal(outbound.length, beforeCalls);
});

test('Vercel Function accepts parsed JSON bodies for same-origin manifest inspection', async () => {
  const beforeCalls = outbound.length;
  const request = makeRequest('manifest', {
    method: 'POST',
    origin: 'https://tesla-host.vercel.app',
    body: { repoUrl: 'sample-owner/sample-bot' }
  });
  const response = makeResponse();
  await adminFunction(request, response);
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.repository, 'sample-owner/sample-bot');
  assert.equal(payload.commitSha, TEST_COMMIT_SHA);
  assert.equal(payload.manifest.hasSession, true);
  assert.equal(outbound.slice(beforeCalls).filter((call) => call.url.startsWith('https://api.github.com/')).length, 3);
  assert.doesNotMatch(response.body, /test-only-vercel-admin-password|test-only-vercel-heroku-key/);
});

test('Vercel function rejects a cross-origin POST before parsing or forwarding it', async () => {
  const beforeCalls = outbound.length;
  const request = makeRequest('manifest', {
    method: 'POST',
    origin: 'https://attacker.example',
    body: { repoUrl: 'sample-owner/sample-bot' }
  });
  const response = makeResponse();
  await adminFunction(request, response);
  assert.equal(response.statusCode, 403);
  assert.equal(outbound.length, beforeCalls);
});
