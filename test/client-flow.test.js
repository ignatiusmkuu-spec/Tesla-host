const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const clientSource = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'public/admin.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

class FakeElement {
  constructor(id, value = '') {
    this.id = id;
    this.value = value;
    this.textContent = '';
    this.dataset = {};
    this.style = {};
    this.disabled = false;
    this.attributes = {};
    this.listeners = new Map();
    this.focusCount = 0;
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  replaceChildren() { this.textContent = ''; }
  append() {}
  scrollIntoView() {}
  focus() { this.focusCount += 1; }
  getClientRects() { return []; }
  dispatchEvent(event) {
    for (const handler of this.listeners.get(event.type) || []) handler(event);
    return !event.defaultPrevented;
  }
}

class FakeCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
    this.cancelable = Boolean(options.cancelable);
    this.defaultPrevented = false;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
}

class FakeEvent {
  constructor(type) { this.type = type; this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
}

function makeSession() {
  return JSON.stringify({
    noiseKey: {},
    signedIdentityKey: {},
    signedPreKey: {},
    registrationId: 1,
    advSecretKey: 'test'
  });
}

function runPublicClient() {
  const session = makeSession();
  const defaults = {
    appName: 'tesla-bot-sample',
    ownerNumbers: '254712345678',
    menuType: 'VIDEO',
    badWords: 'bad,words',
    sessionValue: session
  };
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id, defaults[id] || ''));
    return elements.get(id);
  };
  const windowListeners = new Map();
  const location = { hash: '' };
  const openedUrls = [];
  const window = {
    location,
    setTimeout,
    clearTimeout,
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(handler);
    },
    dispatchEvent(event) {
      for (const handler of windowListeners.get(event.type) || []) handler(event);
      return !event.defaultPrevented;
    },
    open(url) { openedUrls.push(url); return null; }
  };
  const document = {
    getElementById: getElement,
    querySelectorAll: () => [],
    createElement: (tag) => new FakeElement(tag),
    body: { appendChild() {} }
  };
  const context = {
    document, window, CustomEvent: FakeCustomEvent, Event: FakeEvent, TextDecoder, Uint8Array, URL,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'), setTimeout, clearTimeout
  };
  vm.runInNewContext(clientSource, context, { filename: 'public/app.js' });
  let receivedDraft = null;
  window.addEventListener('tesla-host:deploy-draft', (event) => {
    receivedDraft = event.detail;
    event.preventDefault();
  });
  const deployButton = getElement('deployButton');
  for (const handler of deployButton.listeners.get('click') || []) handler();
  return { elements, location, openedUrls, receivedDraft, session };
}

function runAdminClient() {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const windowListeners = new Map();
  const location = { hash: '' };
  const fetchCalls = [];
  const window = {
    location,
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(handler);
    },
    dispatchEvent(event) {
      for (const handler of windowListeners.get(event.type) || []) handler(event);
      return !event.defaultPrevented;
    }
  };
  const document = {
    getElementById: getElement,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: text })
  };
  const fetch = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    return { status: 401, ok: false, json: async () => ({ error: 'unauthorized' }) };
  };
  const context = {
    document, window, CustomEvent: FakeCustomEvent, Event: FakeEvent, TextDecoder, TextEncoder, Uint8Array, URL, fetch,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    Intl, Date, encodeURIComponent
  };
  vm.runInNewContext(adminSource, context, { filename: 'public/admin.js' });
  const session = makeSession();
  const draftEvent = new FakeCustomEvent('tesla-host:deploy-draft', {
    detail: {
      repoUrl: 'https://github.com/ignatiusmkuu-spec/Tesla-bot/tree/main',
      appName: 'tesla-bot-sample',
      env: { APP_NAME: 'tesla-bot-sample', DEV: '254712345678', MENU_TYPE: 'VIDEO', BAD_WORD: 'bad,words', SESSION: session }
    },
    cancelable: true
  });
  window.dispatchEvent(draftEvent);
  return { elements, location, fetchCalls, draftEvent, session, window };
}

test('public Deploy Now stages bot settings in memory and opens the protected Tesla Host section', () => {
  const result = runPublicClient();
  assert.ok(result.receivedDraft, 'the admin panel should receive a same-page draft');
  assert.equal(result.receivedDraft.repoUrl, 'https://github.com/ignatiusmkuu-spec/Tesla-bot/tree/main');
  assert.equal(result.receivedDraft.appName, 'tesla-bot-sample');
  assert.equal(result.receivedDraft.env.APP_NAME, 'tesla-bot-sample');
  assert.equal(result.receivedDraft.env.DEV, '254712345678');
  assert.equal(result.receivedDraft.env.MENU_TYPE, 'VIDEO');
  assert.equal(result.receivedDraft.env.BAD_WORD, 'bad,words');
  assert.equal(result.receivedDraft.env.SESSION, result.session);
  assert.equal(result.location.hash, 'admin');
  assert.equal(result.elements.get('deployState').textContent, 'DRAFT STAGED');
  assert.match(result.elements.get('deployMessage').textContent, /No session has been sent to Tesla Host yet/);
  assert.deepEqual(result.openedUrls, [], 'the public button must not open a Heroku URL or another window');
});

test('admin stages a valid public draft but makes no server request before sign-in', async () => {
  const result = runAdminClient();
  assert.equal(result.draftEvent.defaultPrevented, true);
  assert.equal(result.location.hash, 'admin');
  assert.equal(result.elements.get('repoUrl').value, 'https://github.com/ignatiusmkuu-spec/Tesla-bot/tree/main');
  assert.equal(result.elements.get('adminPassword').focusCount, 1);
  assert.equal(result.fetchCalls.length, 0, 'session/owner values must stay in page memory until a final deployment submission');

  result.elements.get('adminPassword').value = 'test-admin-only';
  const submit = new FakeEvent('submit');
  const pendingLogin = result.elements.get('adminLoginForm').listeners.get('submit')[0](submit);
  await pendingLogin;
  assert.equal(result.fetchCalls.length, 1);
  assert.equal(result.fetchCalls[0].url, '/api/admin/account');
  assert.equal(result.fetchCalls[0].options.body, undefined, 'login must not include the staged session or owner number');
  assert.equal(JSON.stringify(result.fetchCalls[0].options).includes(result.session), false);
});

test('public client contains no direct Heroku deploy redirect', () => {
  assert.doesNotMatch(clientSource, /www\.heroku\.com\/deploy|window\.open\s*\(/i);
  assert.match(clientSource, /tesla-host:deploy-draft/);
});

test('page has an in-site Deploy Now control and the requested phone/WhatsApp contact', () => {
  assert.match(html, /id="deployButton" class="primary-button deploy-now"/);
  assert.match(html, /<span>Deploy Now<\/span>/);
  assert.match(html, /https:\/\/wa\.me\/254706535581/);
  assert.match(html, /tel:\+254706535581/);
  assert.match(html, /\+254 706 535 581/);
  assert.doesNotMatch(html, /www\.heroku\.com\/deploy/i);
});
