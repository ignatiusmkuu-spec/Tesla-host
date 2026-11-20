'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  HerokuApiError,
  createAppSetup,
  getAppSetup,
  listApps,
  verifyAccount
} = require('./lib/heroku-client');
const { RepositoryError, inspectRepository } = require('./lib/github-manifest');
const { validateSession } = require('./lib/session');

const publicRoot = path.resolve(__dirname, 'public');
const BODY_LIMIT = 350 * 1024;
const NAME_PATTERN = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;
const PHONE_PATTERN = /^\d+(?:,\d+)*$/;
const AUTH_FAILURE_LIMIT = 8;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const authFailures = new Map();
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

function securityHeaders() {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
  };
  if (process.env.NODE_ENV === 'production') {
    headers['Strict-Transport-Security'] = 'max-age=15552000; includeSubDomains';
  }
  return headers;
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  response.end(body);
}

function sendText(response, status, text, extraHeaders = {}) {
  const body = Buffer.from(text);
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  response.end(body);
}

function requestProtocol(request) {
  const forwarded = request.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim().toLowerCase();
  return request.socket.encrypted ? 'https' : 'http';
}

function isSecureRequest(request) {
  if (process.env.NODE_ENV !== 'production') return true;
  return requestProtocol(request) === 'https';
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  const forwardedHost = request.headers['x-forwarded-host'];
  const host = (typeof forwardedHost === 'string' ? forwardedHost : request.headers.host || '').split(',')[0].trim();
  if (typeof origin !== 'string' || !host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === `${requestProtocol(request)}://${host}`;
  } catch {
    return false;
  }
}

function configuredForAdmin() {
  return Boolean(process.env.HEROKU_API_KEY && process.env.TESLA_HOST_ADMIN_PASSWORD);
}

function failedAttemptsFor(request) {
  const key = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const events = (authFailures.get(key) || []).filter((time) => now - time < AUTH_WINDOW_MS);
  authFailures.set(key, events);
  return { key, events };
}

function authenticateAdmin(request) {
  const attempts = failedAttemptsFor(request);
  if (attempts.events.length >= AUTH_FAILURE_LIMIT) return { ok: false, limited: true };

  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || authorization.length > 20_000 || !authorization.startsWith('Basic ')) {
    attempts.events.push(Date.now());
    authFailures.set(attempts.key, attempts.events);
    return { ok: false };
  }

  let decoded;
  try {
    decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
  } catch {
    decoded = '';
  }
  const separator = decoded.indexOf(':');
  if (separator < 0 || decoded.slice(0, separator) !== 'admin') {
    attempts.events.push(Date.now());
    authFailures.set(attempts.key, attempts.events);
    return { ok: false };
  }

  const supplied = crypto.createHash('sha256').update(decoded.slice(separator + 1), 'utf8').digest();
  const expected = crypto.createHash('sha256').update(process.env.TESLA_HOST_ADMIN_PASSWORD || '', 'utf8').digest();
  const matched = crypto.timingSafeEqual(supplied, expected);
  if (!matched) {
    attempts.events.push(Date.now());
    authFailures.set(attempts.key, attempts.events);
    return { ok: false };
  }
  authFailures.delete(attempts.key);
  return { ok: true };
}

async function readJson(request) {
  const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new RequestError(415, 'Send a JSON request body.');
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT) throw new RequestError(413, 'The request is too large.');

  let value;
  if (request.body !== undefined) {
    let raw;
    if (Buffer.isBuffer(request.body)) raw = request.body;
    else if (typeof request.body === 'string') raw = Buffer.from(request.body);
    else if (request.body && typeof request.body === 'object') {
      try {
        raw = Buffer.from(JSON.stringify(request.body));
      } catch {
        throw new RequestError(400, 'The JSON request body is invalid.');
      }
    } else {
      throw new RequestError(400, 'The JSON request body is invalid.');
    }
    if (raw.length > BODY_LIMIT) throw new RequestError(413, 'The request is too large.');
    try {
      value = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new RequestError(400, 'The JSON request body is invalid.');
    }
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw new RequestError(413, 'The request is too large.');
      chunks.push(chunk);
    }
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new RequestError(400, 'The JSON request body is invalid.');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'The JSON request body must be an object.');
  }
  return value;
}

function safeAppName(value) {
  return typeof value === 'string' && value.length <= 30 && NAME_PATTERN.test(value);
}

function safeSetupId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function buildOverrides(body, inspected) {
  const manifest = inspected.manifest;
  if (manifest.blocked && manifest.blocked.length) {
    throw new RequestError(400, 'This repository requires a Heroku API credential that Tesla Host intentionally will not share with a bot.');
  }
  if (!manifest.hasSession) {
    throw new RequestError(400, 'The repository manifest must declare a SESSION variable for WhatsApp pairing.');
  }
  if (!body.env || typeof body.env !== 'object' || Array.isArray(body.env)) {
    throw new RequestError(400, 'Provide the environment values required by this bot manifest.');
  }

  const formKeys = new Set((manifest.fields || []).map((field) => field.key));
  for (const key of Object.keys(body.env)) {
    if (!formKeys.has(key)) throw new RequestError(400, 'The request contains a setting that is not declared in this repository manifest.');
  }

  const env = Object.create(null);
  const appNameDeclared = (manifest.fields || []).some((field) => field.key === 'APP_NAME') ||
    (manifest.skipped || []).some((field) => field.key === 'APP_NAME');
  if (appNameDeclared) env.APP_NAME = body.appName;

  for (const field of manifest.fields || []) {
    if (field.key === 'APP_NAME' || field.key === 'HEROKU_API' || field.key === 'DATABASE_URL') continue;
    const raw = body.env[field.key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (field.key === 'SESSION') {
      const session = validateSession(value);
      if (!session.valid) throw new RequestError(400, session.message);
      env.SESSION = value;
      continue;
    }
    if (field.key === 'DEV' && value && !PHONE_PATTERN.test(value)) {
      throw new RequestError(400, 'DEV must contain international digits only, with multiple numbers separated by commas.');
    }
    if (field.type === 'menu' && value && !['VIDEO', 'LINK', 'IMAGE'].includes(value.toUpperCase())) {
      throw new RequestError(400, 'MENU_TYPE must be VIDEO, LINK, or IMAGE.');
    }
    if (!value) {
      if (field.required && !field.defaultValue) throw new RequestError(400, `Enter the required ${field.key} setting.`);
      if (field.defaultValue) env[field.key] = field.defaultValue;
      continue;
    }
    if (value.length > (field.key === 'SESSION' ? 250_000 : 20_000)) {
      throw new RequestError(400, `The ${field.key} setting is too long.`);
    }
    env[field.key] = field.type === 'menu' ? value.toUpperCase() : value;
  }
  return env;
}

function apiError(response, error) {
  if (error instanceof RequestError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  if (error instanceof RepositoryError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  if (error instanceof HerokuApiError) {
    const status = error.status === 401 ? 502 : (error.status >= 400 && error.status < 500 ? error.status : 502);
    sendJson(response, status, { error: error.message });
    return;
  }
  sendJson(response, 500, { error: 'The request could not be completed. No sensitive values were saved by Tesla Host.' });
}

async function handleAdminApi(request, response, pathname) {
  if (!['GET', 'POST'].includes(request.method)) {
    sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
    return;
  }
  if (!isSecureRequest(request)) {
    sendJson(response, 403, { error: 'Admin requests require HTTPS.' });
    return;
  }
  if (request.method === 'POST' && !isSameOrigin(request)) {
    sendJson(response, 403, { error: 'This admin request must come from the Tesla Host site.' });
    return;
  }
  if (!configuredForAdmin()) {
    sendJson(response, 503, { error: 'Admin actions are not configured on this server.' });
    return;
  }
  const authentication = authenticateAdmin(request);
  if (!authentication.ok) {
    if (authentication.limited) {
      sendJson(response, 429, { error: 'Too many failed admin sign-in attempts. Wait before trying again.' });
      return;
    }
    sendJson(response, 401, { error: 'Admin password not accepted.' }, { 'WWW-Authenticate': 'Basic realm="Tesla Host admin", charset="UTF-8"' });
    return;
  }

  try {
    if (request.method === 'GET' && pathname === '/api/admin/account') {
      const account = await verifyAccount();
      sendJson(response, 200, account);
      return;
    }
    if (request.method === 'GET' && pathname === '/api/admin/bots') {
      const bots = await listApps();
      sendJson(response, 200, { bots });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/admin/manifest') {
      const body = await readJson(request);
      const inspected = await inspectRepository(body.repoUrl);
      sendJson(response, 200, inspected);
      return;
    }
    if (request.method === 'POST' && pathname === '/api/admin/deploy') {
      const body = await readJson(request);
      if (!safeAppName(body.appName)) {
        throw new RequestError(400, 'Choose a unique Heroku app name with 3–30 lowercase letters, digits, or internal hyphens; it must start with a letter and end with a letter or digit.');
      }
      if (typeof body.commitSha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(body.commitSha)) {
        throw new RequestError(400, 'Inspect the repository again to pin its source commit before deployment.');
      }
      if (body.confirmResources !== true) {
        throw new RequestError(409, 'Review the declared resources and acknowledge possible Heroku charges before deploying.');
      }
      const inspected = await inspectRepository(body.repoUrl);
      if (inspected.commitSha.toLowerCase() !== body.commitSha.toLowerCase()) {
        throw new RequestError(409, 'The selected GitHub branch changed after review. Inspect it again and re-check its settings before deploying.');
      }
      const env = buildOverrides(body, inspected);
      const setup = await createAppSetup({
        appName: body.appName,
        tarballUrl: inspected.tarballUrl,
        env
      });
      sendJson(response, 202, { setup });
      return;
    }
    const setupMatch = pathname.match(/^\/api\/admin\/setups\/([^/]+)$/);
    if (request.method === 'GET' && setupMatch) {
      const id = decodeURIComponent(setupMatch[1]);
      if (!safeSetupId(id)) throw new RequestError(400, 'The Heroku setup ID is invalid.');
      const setup = await getAppSetup(id);
      sendJson(response, 200, { setup });
      return;
    }
    sendJson(response, 404, { error: 'Admin API route not found.' });
  } catch (error) {
    apiError(response, error);
  }
}

function sendStatic(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendText(response, 400, 'Bad request');
    return;
  }
  if (decodedPath === '/') decodedPath = '/index.html';
  const filePath = path.resolve(publicRoot, `.${decodedPath}`);
  if (!filePath.startsWith(`${publicRoot}${path.sep}`)) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      sendText(response, 404, 'Not found');
      return;
    }
    const headers = {
      ...securityHeaders(),
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    };
    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(filePath).on('error', () => {
      if (!response.headersSent) response.writeHead(500, securityHeaders());
      response.end('Internal server error');
    }).pipe(response);
  });
}

function createServer() {
  return http.createServer((request, response) => {
    let parsed;
    try {
      parsed = new URL(request.url, 'http://localhost');
    } catch {
      sendText(response, 400, 'Bad request');
      return;
    }
    if (parsed.pathname.startsWith('/api/admin/')) {
      void handleAdminApi(request, response, parsed.pathname);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }
    sendStatic(request, response, parsed.pathname);
  });
}

if (require.main === module) {
  const server = createServer();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`Tesla Host listening on ${port}`);
  });
}

module.exports = { createServer, handleAdminApi };
