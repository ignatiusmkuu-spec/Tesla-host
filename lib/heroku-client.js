'use strict';

const HEROKU_API = 'https://api.heroku.com';
const ACCEPT = 'application/vnd.heroku+json; version=3';

class HerokuApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HerokuApiError';
    this.status = status;
  }
}

function messageForStatus(status) {
  if (status === 401) return 'Heroku rejected the saved API credential.';
  if (status === 403) return 'The connected Heroku account cannot perform this action.';
  if (status === 404) return 'Heroku could not find that app setup.';
  if (status === 409) return 'Heroku reports a name or resource conflict. Choose another app name.';
  if (status === 422) return 'Heroku rejected the setup. Review the repository manifest and required settings.';
  if (status === 429) return 'Heroku rate-limited this request. Wait briefly and try again.';
  if (status >= 500) return 'Heroku is temporarily unavailable. Try again later.';
  return 'Heroku could not complete the request.';
}

async function herokuRequest(path, options = {}) {
  const token = process.env.HEROKU_API_KEY;
  if (!token) throw new HerokuApiError(503, 'The Heroku API is not configured on this server.');
  if (!path.startsWith('/') || path.startsWith('//')) throw new TypeError('Invalid Heroku API path.');

  const headers = {
    Accept: ACCEPT,
    Authorization: `Bearer ${token}`,
    'User-Agent': 'Tesla-Host/1.0'
  };
  const request = { method: options.method || 'GET', headers, signal: AbortSignal.timeout(20_000) };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(`${HEROKU_API}${path}`, request);
  } catch {
    throw new HerokuApiError(502, 'Could not reach the Heroku Platform API.');
  }

  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (!response.ok) throw new HerokuApiError(response.status, messageForStatus(response.status));
  if (raw && !data) throw new HerokuApiError(502, 'Heroku returned an unreadable response.');
  return data;
}

async function verifyAccount() {
  await herokuRequest('/account');
  return { connected: true };
}

async function listApps() {
  const apps = await herokuRequest('/apps');
  if (!Array.isArray(apps)) throw new HerokuApiError(502, 'Heroku returned an unexpected apps response.');
  return apps
    .filter((app) => app && typeof app.name === 'string')
    .map((app) => ({
      name: app.name,
      url: typeof app.web_url === 'string' ? app.web_url : null,
      createdAt: typeof app.created_at === 'string' ? app.created_at : null,
      updatedAt: typeof app.updated_at === 'string' ? app.updated_at : null
    }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

async function createAppSetup({ appName, tarballUrl, env }) {
  const result = await herokuRequest('/app-setups', {
    method: 'POST',
    body: {
      app: { name: appName },
      source_blob: { url: tarballUrl },
      overrides: { env }
    }
  });
  return safeSetup(result);
}

async function getAppSetup(id) {
  const result = await herokuRequest(`/app-setups/${encodeURIComponent(id)}`);
  return safeSetup(result);
}

function safeSetup(result) {
  if (!result || typeof result.id !== 'string') {
    throw new HerokuApiError(502, 'Heroku returned an unexpected setup response.');
  }
  const status = typeof result.status === 'string' ? result.status : 'unknown';
  return {
    id: result.id,
    status,
    appName: result.app && typeof result.app.name === 'string' ? result.app.name : null,
    appUrl: result.resolved_success_url && typeof result.resolved_success_url === 'string'
      ? result.resolved_success_url
      : null,
    failureMessage: status === 'failed' ? 'Heroku reported that this setup failed. Check the Heroku Dashboard for details.' : null,
    createdAt: typeof result.created_at === 'string' ? result.created_at : null
  };
}

module.exports = {
  HerokuApiError,
  createAppSetup,
  getAppSetup,
  herokuRequest,
  listApps,
  verifyAccount
};
