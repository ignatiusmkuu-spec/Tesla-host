'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { makeFormSchema, parseRepositoryInput } = require('../lib/github-manifest');
const { createServer } = require('../server');

const TEST_HEROKU_KEY = 'test-only-heroku-key';
const TEST_ADMIN_PASSWORD = 'test-only-admin-password';
const TEST_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const TEST_SESSION = Buffer.from(JSON.stringify({
  noiseKey: {},
  signedIdentityKey: {},
  signedPreKey: {},
  registrationId: 7,
  advSecretKey: 'test-only-session'
})).toString('base64');
const SETUP_ID = 'd795a5e7-6bb8-4ce6-9f3a-27ad9231b7a1';
const manifest = {
  name: 'Example bot',
  description: 'A test manifest',
  env: {
    APP_NAME: { required: true },
    DEV: { required: true },
    SESSION: { required: true },
    MENU_TYPE: { value: 'VIDEO', required: false },
    BAD_WORD: { value: 'example,default', required: false },
    HEROKU_API: { required: false },
    DATABASE_URL: { required: false }
  },
  addons: [{ plan: 'heroku-postgresql:essential-0' }],
  buildpacks: [{ url: 'https://github.com/heroku/heroku-buildpack-nodejs.git' }]
};

let originalEnv;
let originalFetch;
let server;
let baseUrl;
let outbound = [];
let setupBody;
let activeCommitSha = TEST_COMMIT_SHA;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function stubFetch() {
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    outbound.push({ url: url.href, method: options.method || 'GET', headers: options.headers || {}, body: options.body || null });
    if (url.origin === 'https://api.heroku.com') {
      if (url.pathname === '/account') return jsonResponse({ id: 'account-id', email: 'private@example.invalid' });
      if (url.pathname === '/apps') return jsonResponse([
        { name: 'tesla-bot-test', web_url: 'https://tesla-bot-test.herokuapp.com', updated_at: '2026-11-19T00:00:00Z', config_vars: { SESSION: TEST_SESSION } },
        { name: 'unrelated-app', web_url: 'https://unrelated-app.herokuapp.com', updated_at: '2026-11-20T00:00:00Z', config_vars: { HEROKU_API_KEY: TEST_HEROKU_KEY } }
      ]);
      if (url.pathname === '/app-setups' && options.method === 'POST') {
        setupBody = JSON.parse(options.body);
        return jsonResponse({ id: SETUP_ID, status: 'pending', app: { name: setupBody.app.name } }, 202);
      }
      if (url.pathname === `/app-setups/${SETUP_ID}`) {
        const appName = setupBody ? setupBody.app.name : 'another-bot';
        return jsonResponse({
          id: SETUP_ID,
          status: 'succeeded',
          app: { name: appName },
          resolved_success_url: `https://${appName}.herokuapp.com`,
          failure_message: 'untrusted message must not be reflected'
        });
      }
      return jsonResponse({ id: 'unexpected' }, 404);
    }
    if (url.origin === 'https://api.github.com') {
      if (url.pathname === '/repos/sample-owner/sample-bot') {
        return jsonResponse({ private: false, default_branch: 'main' });
      }
      if (url.pathname === '/repos/sample-owner/sample-bot/commits') {
        return jsonResponse([{ sha: activeCommitSha }]);
      }
      if (url.pathname === '/repos/sample-owner/sample-bot/contents/app.json') {
        return jsonResponse({
          encoding: 'base64',
          content: Buffer.from(JSON.stringify(manifest)).toString('base64')
        });
      }
      return jsonResponse({ message: 'not found' }, 404);
    }
    throw new Error('Unexpected outbound destination in test');
  };
}

function adminHeader(password = TEST_ADMIN_PASSWORD) {
  return `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
}

function request(method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const req = http.request(url, { method, headers: { Connection: 'close', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* plain text response */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

function adminHeaders() {
  return { Authorization: adminHeader() };
}

function postHeaders() {
  return { ...adminHeaders(), Origin: baseUrl, 'Content-Type': 'application/json' };
}

before(async () => {
  originalEnv = {
    HEROKU_API_KEY: process.env.HEROKU_API_KEY,
    TESLA_HOST_ADMIN_PASSWORD: process.env.TESLA_HOST_ADMIN_PASSWORD,
    NODE_ENV: process.env.NODE_ENV
  };
  originalFetch = global.fetch;
  process.env.HEROKU_API_KEY = TEST_HEROKU_KEY;
  process.env.TESLA_HOST_ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
  process.env.NODE_ENV = 'test';
  outbound = [];
  setupBody = null;
  activeCommitSha = TEST_COMMIT_SHA;
  stubFetch();
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('repository parser accepts GitHub forms and rejects non-GitHub targets', () => {
  assert.deepEqual(parseRepositoryInput('sample-owner/sample-bot'), {
    owner: 'sample-owner', repo: 'sample-bot', branch: null
  });
  assert.equal(parseRepositoryInput('https://github.com/sample-owner/sample-bot/tree/release-2').branch, 'release-2');
  assert.throws(() => parseRepositoryInput('https://evil.example/owner/repo'), /github\.com/);
  assert.throws(() => parseRepositoryInput('https://user@github.com/owner/repo'), /github\.com/);
});

test('manifest schema omits the Heroku API credential and recognizes auto-provisioned values', () => {
  const schema = makeFormSchema(manifest);
  assert.equal(schema.hasSession, true);
  assert.equal(schema.fields.some((field) => field.key === 'SESSION' && field.sensitive), true);
  assert.equal(schema.fields.some((field) => field.key === 'HEROKU_API'), false);
  assert.equal(schema.skipped.some((field) => field.key === 'DATABASE_URL'), true);
  assert.deepEqual(schema.addons, ['heroku-postgresql:essential-0']);
});

test('static console is served with security headers', async () => {
  const result = await request('GET', '/');
  assert.equal(result.status, 200);
  assert.match(result.headers['content-security-policy'], /connect-src 'self'/);
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.match(result.body, /Admin control panel/);
});

test('admin API refuses missing authorization without calling Heroku', async () => {
  const beforeCalls = outbound.length;
  const result = await request('GET', '/api/admin/account');
  assert.equal(result.status, 401);
  assert.equal(outbound.length, beforeCalls);
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('admin API rejects cross-origin submissions before calling external services', async () => {
  const beforeCalls = outbound.length;
  const result = await request('POST', '/api/admin/manifest', {
    headers: { ...adminHeaders(), Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: { repoUrl: 'sample-owner/sample-bot' }
  });
  assert.equal(result.status, 403);
  assert.equal(outbound.length, beforeCalls);
});

test('authenticated account response does not expose account or API-key details', async () => {
  const result = await request('GET', '/api/admin/account', { headers: adminHeaders() });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { connected: true });
  assert.doesNotMatch(JSON.stringify(result.body), /private@example|test-only-heroku-key/);
  assert.equal(outbound.at(-1).headers.Authorization, `Bearer ${TEST_HEROKU_KEY}`);
});

test('admin inventory returns all account app names and URLs without config values', async () => {
  const result = await request('GET', '/api/admin/bots', { headers: adminHeaders() });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.bots.map((app) => app.name), ['unrelated-app', 'tesla-bot-test']);
  assert.doesNotMatch(JSON.stringify(result.body), /test-only-heroku-key|test-only-session|config_vars/);
});

test('repository inspection returns a safe manifest pinned to an immutable commit', async () => {
  const result = await request('POST', '/api/admin/manifest', {
    headers: postHeaders(),
    body: { repoUrl: 'sample-owner/sample-bot' }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.repository, 'sample-owner/sample-bot');
  assert.equal(result.body.commitSha, TEST_COMMIT_SHA);
  assert.equal(result.body.tarballUrl, `https://github.com/sample-owner/sample-bot/tarball/${TEST_COMMIT_SHA}`);
  assert.equal(result.body.manifest.hasSession, true);
  assert.equal(result.body.manifest.fields.some((field) => field.key === 'SESSION' && field.sensitive), true);
  assert.equal(result.body.manifest.fields.some((field) => field.key === 'HEROKU_API'), false);
  assert.deepEqual(result.body.manifest.addons, ['heroku-postgresql:essential-0']);
  assert.doesNotMatch(JSON.stringify(result.body), /test-only-heroku-key|test-only-session/);
});

test('deployment requires resource acknowledgement before any provisioning call', async () => {
  const beforeCalls = outbound.length;
  const result = await request('POST', '/api/admin/deploy', {
    headers: postHeaders(),
    body: { repoUrl: 'sample-owner/sample-bot', commitSha: TEST_COMMIT_SHA, appName: 'another-bot', env: {}, confirmResources: false }
  });
  assert.equal(result.status, 409);
  assert.equal(outbound.length, beforeCalls);
  assert.equal(setupBody, null);
});

test('deployment rejects a branch that moved after the admin reviewed its manifest', async () => {
  const inspected = await request('POST', '/api/admin/manifest', {
    headers: postHeaders(),
    body: { repoUrl: 'sample-owner/sample-bot' }
  });
  assert.equal(inspected.status, 200);
  const beforeSetups = outbound.filter((call) => call.method === 'POST' && call.url.endsWith('/app-setups')).length;
  const priorCommitSha = activeCommitSha;
  activeCommitSha = 'fedcba9876543210fedcba9876543210fedcba98';
  const result = await request('POST', '/api/admin/deploy', {
    headers: postHeaders(),
    body: {
      repoUrl: 'sample-owner/sample-bot',
      commitSha: inspected.body.commitSha,
      appName: 'another-bot',
      env: { DEV: '254712345678', SESSION: TEST_SESSION },
      confirmResources: true
    }
  });
  activeCommitSha = priorCommitSha;
  assert.equal(result.status, 409);
  assert.match(result.body.error, /branch changed/);
  assert.equal(outbound.filter((call) => call.method === 'POST' && call.url.endsWith('/app-setups')).length, beforeSetups);
});

test('bot setup sends user session and owner only to Heroku and never forwards Tesla Host API key', async () => {
  const beforeCalls = outbound.length;
  const result = await request('POST', '/api/admin/deploy', {
    headers: postHeaders(),
    body: {
      repoUrl: 'sample-owner/sample-bot',
      commitSha: TEST_COMMIT_SHA,
      appName: 'another-bot',
      env: { DEV: '254712345678', SESSION: TEST_SESSION, MENU_TYPE: 'VIDEO' },
      confirmResources: true
    }
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.setup.id, SETUP_ID);
  assert.equal(setupBody.app.name, 'another-bot');
  assert.equal(setupBody.source_blob.url, `https://github.com/sample-owner/sample-bot/tarball/${TEST_COMMIT_SHA}`);
  assert.equal(setupBody.overrides.env.SESSION, TEST_SESSION);
  assert.equal(setupBody.overrides.env.DEV, '254712345678');
  assert.equal(setupBody.overrides.env.APP_NAME, 'another-bot');
  assert.equal(Object.hasOwn(setupBody.overrides.env, 'HEROKU_API'), false);
  assert.equal(outbound.slice(beforeCalls).some((call) => call.method === 'POST' && call.url.endsWith('/app-setups')), true);
  assert.doesNotMatch(JSON.stringify(result.body), /test-only-session|test-only-heroku-key/);
});

test('setup polling returns a safe Heroku URL and suppresses external failure text', async () => {
  const result = await request('GET', `/api/admin/setups/${SETUP_ID}`, { headers: adminHeaders() });
  assert.equal(result.status, 200);
  assert.equal(result.body.setup.status, 'succeeded');
  assert.equal(result.body.setup.appUrl, 'https://another-bot.herokuapp.com');
  assert.equal(result.body.setup.failureMessage, null);
  assert.doesNotMatch(JSON.stringify(result.body), /untrusted message|test-only-session/);
});
