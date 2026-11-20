(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    password: null,
    manifest: null,
    setup: null,
    pendingDraft: null,
    fields: new Map(),
    busy: false,
    deploying: false
  };

  function showMessage(element, message, tone = '') {
    if (!element) return;
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function basicHeader() {
    const bytes = new TextEncoder().encode(`admin:${state.password || ''}`);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `Basic ${btoa(binary)}`;
  }

  async function request(path, options = {}) {
    const headers = { Authorization: basicHeader() };
    const init = {
      method: options.method || 'GET',
      headers,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer'
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(`/api/admin${path}`, init);
    let result = {};
    try {
      result = await response.json();
    } catch {
      result = {};
    }
    if (response.status === 401) {
      state.password = null;
      throw new Error('Admin password not accepted. Sign in again.');
    }
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'The request could not be completed.');
    return result;
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    button.disabled = busy;
    if (label) button.dataset.idleLabel = label;
    const labelNode = button.querySelector('[data-button-label]');
    if (labelNode) labelNode.textContent = busy ? 'Working…' : button.dataset.idleLabel;
  }

  function clearSecretInputs() {
    state.pendingDraft = null;
    for (const [key, field] of state.fields) {
      if (key === 'SESSION' || key === 'DEV' || field.type === 'password') field.value = '';
    }
    const adminPassword = $('adminPassword');
    if (adminPassword) adminPassword.value = '';
    const publicSession = $('sessionValue');
    if (publicSession) publicSession.value = '';
    const publicOwner = $('ownerNumbers');
    if (publicOwner) publicOwner.value = '';
    const appName = $('botAppName');
    if (appName) appName.value = '';
    const checkbox = $('confirmResources');
    if (checkbox) checkbox.checked = false;
    window.dispatchEvent(new Event('tesla-host:draft-consumed'));
  }

  function logout() {
    state.password = null;
    state.manifest = null;
    state.setup = null;
    clearSecretInputs();
    state.fields.clear();
    $('adminLoginCard').hidden = false;
    $('adminConsole').hidden = true;
    $('manifestPanel').hidden = true;
    $('setupResult').hidden = true;
    $('adminPassword').value = '';
    $('repoUrl').value = '';
    $('botList').replaceChildren();
    showMessage($('adminLoginMessage'), 'Signed out. Admin credentials and session fields were cleared from this page.');
  }

  function safeHerokuUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.herokuapp.com')) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function formatDate(value) {
    if (typeof value !== 'string') return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
  }

  function renderBots(bots) {
    const list = $('botList');
    list.replaceChildren();
    if (!Array.isArray(bots) || bots.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'admin-muted';
      empty.textContent = 'No apps found in this Heroku account yet.';
      list.append(empty);
      return;
    }
    for (const bot of bots) {
      const row = document.createElement('div');
      row.className = 'bot-row';
      const copy = document.createElement('div');
      copy.className = 'bot-row-copy';
      const name = document.createElement('strong');
      name.textContent = typeof bot.name === 'string' ? bot.name : 'Tesla bot';
      copy.append(name);
      const updated = formatDate(bot.updatedAt || bot.createdAt);
      if (updated) {
        const date = document.createElement('small');
        date.textContent = `Updated ${updated}`;
        copy.append(date);
      }
      row.append(copy);
      const url = safeHerokuUrl(bot.url);
      if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Open ↗';
        row.append(link);
      }
      list.append(row);
    }
  }

  async function refreshBots() {
    const button = $('refreshBots');
    setBusy(button, true, 'Refresh bots');
    showMessage($('botListMessage'), 'Checking the connected Heroku account…');
    try {
      const result = await request('/bots');
      renderBots(result.bots);
      showMessage($('botListMessage'), 'Bot list refreshed.', 'success');
    } catch (error) {
      showMessage($('botListMessage'), error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  function appendTextItem(list, text) {
    const item = document.createElement('li');
    item.textContent = text;
    list.append(item);
  }

  function appendResourceLink(list, addon) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = addon;
    item.append(label);
    const provider = addon.split(':')[0];
    if (/^[a-z0-9-]+$/i.test(provider)) {
      const link = document.createElement('a');
      link.href = `https://elements.heroku.com/addons/${encodeURIComponent(provider)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Pricing ↗';
      item.append(link);
    }
    list.append(item);
  }

  function renderCostEstimate(addons) {
    const box = $('costEstimate');
    box.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = 'Heroku cost guide';
    const paragraph = document.createElement('p');
    const lines = ['A running Basic dyno can cost up to US$7/month at 24/7 usage.'];
    const postgres = addons.some((addon) => /^heroku-postgresql:essential-0$/i.test(addon));
    const otherAddons = addons.filter((addon) => !/^heroku-postgresql:essential-0$/i.test(addon));
    if (postgres) lines.push('Postgres Essential-0 is US$5/month; together, budget about US$12/month per bot running 24/7.');
    if (otherAddons.length) lines.push('Other add-ons may add charges; check each linked plan before approving.');
    if (!addons.length) lines.push('No add-ons are declared in this manifest.');
    paragraph.textContent = `${lines.join(' ')} Heroku prorates usage; final bills can vary by account, uptime, tax, and plan changes.`;
    const source = document.createElement('a');
    source.href = 'https://devcenter.heroku.com/articles/usage-and-billing';
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = 'Heroku billing details ↗';
    box.append(heading, paragraph, source);
  }

  function renderWarnings(manifest) {
    const container = $('manifestWarnings');
    container.replaceChildren();
    const messages = [];
    if (manifest.blocked && manifest.blocked.length) {
      messages.push(`Cannot deploy automatically: ${manifest.blocked.join(', ')} is required but Tesla Host will not pass its Heroku account credential to a bot.`);
    }
    if (!manifest.hasSession) messages.push('This repository does not declare SESSION in app.json, so it cannot use the WhatsApp pairing flow.');
    if (manifest.skipped) {
      for (const skipped of manifest.skipped) {
        if (skipped.key !== 'APP_NAME') messages.push(`${skipped.key}: ${skipped.reason}`);
      }
    }
    if (manifest.generated && manifest.generated.length) {
      messages.push(`Heroku will generate: ${manifest.generated.map((item) => item.key).join(', ')}.`);
    }
    for (const message of messages) {
      const item = document.createElement('p');
      item.className = 'admin-warning';
      item.textContent = message;
      container.append(item);
    }
  }

  function makeField(field) {
    const wrapper = document.createElement('div');
    wrapper.className = `field${field.type === 'session' ? ' full-field admin-session-field' : ''}`;
    const id = `manifest-${field.key.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.append(document.createTextNode(field.key.replaceAll('_', ' ')));
    const key = document.createElement('code');
    key.className = 'env-key';
    key.textContent = field.key;
    label.append(' ', key);
    if (field.required) {
      const required = document.createElement('span');
      required.className = 'required-mark';
      required.textContent = '*';
      label.append(' ', required);
    } else {
      const optional = document.createElement('span');
      optional.className = 'optional-mark';
      optional.textContent = 'OPTIONAL';
      label.append(optional);
    }

    let input;
    if (field.type === 'session') {
      input = document.createElement('textarea');
      input.rows = 4;
      input.placeholder = 'Paste the full session from the pairing site';
      input.autocomplete = 'off';
      input.spellcheck = false;
    } else if (field.type === 'menu') {
      input = document.createElement('select');
      for (const [value, title] of [['VIDEO', 'Video menu'], ['LINK', 'Link menu'], ['IMAGE', 'Image menu']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = title;
        input.append(option);
      }
    } else {
      input = document.createElement('input');
      input.type = field.sensitive ? 'password' : 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (field.key === 'DEV') {
        input.inputMode = 'numeric';
        input.placeholder = '254712345678,14155550123';
      }
      if (field.key === 'BAD_WORD') input.placeholder = 'Comma-separated list';
      if (field.defaultValue) input.value = field.defaultValue;
    }
    input.id = id;
    input.name = field.key;
    input.dataset.envKey = field.key;
    input.dataset.sensitive = field.sensitive || field.type === 'session' ? 'true' : 'false';
    if (field.required) input.required = true;
    if (field.type === 'menu' && field.defaultValue && ['VIDEO', 'LINK', 'IMAGE'].includes(field.defaultValue.toUpperCase())) {
      input.value = field.defaultValue.toUpperCase();
    }
    wrapper.append(label, input);
    if (field.description) {
      const help = document.createElement('span');
      help.className = 'field-help';
      help.textContent = field.description;
      wrapper.append(help);
    }
    input.addEventListener('input', updateDeployReady);
    input.addEventListener('change', updateDeployReady);
    state.fields.set(field.key, input);
    return wrapper;
  }

  function validateSession(value) {
    let text = String(value || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
    if (!text) return 'A WhatsApp SESSION is required.';
    text = text.replace(/^[A-Za-z0-9_-]{1,32}:~/, '');
    let json = text;
    if (!text.startsWith('{')) {
      const base64 = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return 'The session format is not supported.';
      const unpadded = base64.replace(/=+$/, '');
      if (unpadded.length % 4 === 1) return 'The session appears incomplete.';
      const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
      try {
        const binary = atob(padded);
        json = new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
      } catch {
        return 'The session could not be decoded.';
      }
    }
    let credentials;
    try {
      credentials = JSON.parse(json);
    } catch {
      return 'The session is not valid JSON or is incomplete.';
    }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return 'The session does not contain WhatsApp credentials.';
    const required = ['noiseKey', 'signedIdentityKey', 'signedPreKey', 'registrationId', 'advSecretKey'];
    if (required.some((key) => !(key in credentials))) return 'The session is missing required WhatsApp credential fields.';
    return '';
  }

  function validAppName(value) {
    return typeof value === 'string' && /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(value);
  }

  function updateDeployReady() {
    const appName = $('botAppName').value.trim();
    const appNameOkay = validAppName(appName);
    $('botAppName').setAttribute('aria-invalid', appName && !appNameOkay ? 'true' : 'false');
    let fieldsOkay = Boolean(state.manifest && state.manifest.hasSession && !(state.manifest.blocked || []).length);
    for (const field of (state.manifest && state.manifest.fields) || []) {
      if (field.key === 'APP_NAME' || field.key === 'HEROKU_API' || field.key === 'DATABASE_URL') continue;
      const input = state.fields.get(field.key);
      if (!input) continue;
      const value = input.value.trim();
      let error = '';
      if (field.required && !value && !field.defaultValue) error = `${field.key} is required.`;
      if (field.key === 'SESSION' && value) error = validateSession(value);
      if (field.key === 'DEV' && value && !/^\d+(?:,\d+)*$/.test(value)) error = 'Use digits only and separate multiple numbers with commas.';
      if (field.type === 'menu' && value && !['VIDEO', 'LINK', 'IMAGE'].includes(value.toUpperCase())) error = 'Choose VIDEO, LINK, or IMAGE.';
      input.setAttribute('aria-invalid', error ? 'true' : 'false');
      if (error) fieldsOkay = false;
    }
    const ready = appNameOkay && fieldsOkay && $('confirmResources').checked && !state.busy;
    $('deployBotButton').disabled = !ready;
  }

  function renderManifest(result) {
    state.manifest = result;
    state.fields.clear();
    $('manifestFields').replaceChildren();
    $('manifestWarnings').replaceChildren();
    $('manifestName').textContent = result.manifest.name || result.repository;
    const branchLabel = `Branch: ${result.branch} · commit ${String(result.commitSha || '').slice(0, 12)}`;
    $('manifestDescription').textContent = result.manifest.description
      ? `${result.manifest.description} · ${branchLabel}`
      : branchLabel;
    $('manifestRepoLink').href = result.repositoryUrl;
    $('manifestRepoLink').textContent = `${result.repository} ↗`;
    $('manifestPanel').hidden = false;
    $('setupResult').hidden = true;

    const addons = $('addonList');
    addons.replaceChildren();
    if (result.manifest.addons.length) {
      result.manifest.addons.forEach((addon) => appendResourceLink(addons, addon));
    } else {
      appendTextItem(addons, 'No add-ons declared in app.json.');
    }
    const buildpackBlock = $('buildpackBlock');
    const buildpacks = $('buildpackList');
    buildpacks.replaceChildren();
    buildpackBlock.hidden = !(result.manifest.buildpacks || []).length;
    (result.manifest.buildpacks || []).forEach((buildpack) => appendTextItem(buildpacks, buildpack));

    const postdeployBlock = $('postdeployBlock');
    postdeployBlock.hidden = !result.manifest.postdeploy;
    $('postdeployCommand').textContent = result.manifest.postdeploy || '';
    renderCostEstimate(result.manifest.addons || []);
    renderWarnings(result.manifest);

    for (const field of result.manifest.fields || []) {
      $('manifestFields').append(makeField(field));
    }
    if (!(result.manifest.fields || []).length) {
      const note = document.createElement('p');
      note.className = 'admin-muted';
      note.textContent = 'No user-entered configuration variables were found in this manifest.';
      $('manifestFields').append(note);
    }
    const generated = $('generatedFields');
    generated.replaceChildren();
    if (result.manifest.generated && result.manifest.generated.length) {
      const note = document.createElement('p');
      note.className = 'admin-muted';
      note.textContent = `Heroku will generate: ${result.manifest.generated.map((item) => item.key).join(', ')}.`;
      generated.append(note);
    }
    $('resourceConfirmLabel').hidden = false;
    $('confirmResources').checked = false;
    showMessage($('deployBotMessage'), 'Review the manifest, enter the required values, and acknowledge resource provisioning before creating the app.');
    if (state.pendingDraft) applyPendingDraft();
    updateDeployReady();
  }

  async function inspectRepository(event) {
    event.preventDefault();
    return inspectRepositoryValue($('repoUrl').value.trim());
  }

  async function inspectRepositoryValue(repoUrl) {
    if (!state.password || state.busy) return;
    const button = $('inspectRepoButton');
    state.busy = true;
    button.disabled = true;
    $('manifestPanel').hidden = true;
    showMessage($('repoMessage'), 'Reading the public repository manifest…');
    $('repoUrl').value = repoUrl;
    try {
      const result = await request('/manifest', {
        method: 'POST',
        body: { repoUrl }
      });
      renderManifest(result);
      showMessage($('repoMessage'), `Manifest ready from ${result.repository} (${result.branch}).`, 'success');
    } catch (error) {
      showMessage($('repoMessage'), error.message, 'error');
    } finally {
      state.busy = false;
      button.disabled = false;
      updateDeployReady();
    }
  }

  function applyPendingDraft() {
    const draft = state.pendingDraft;
    if (!draft || !state.manifest || !state.manifest.hasSession || !state.fields.has('SESSION')) return false;
    $('botAppName').value = draft.appName;
    for (const [key, value] of Object.entries(draft.env)) {
      if (key === 'APP_NAME') continue;
      const field = state.fields.get(key);
      if (field) field.value = value;
    }
    if (!state.fields.get('SESSION').value) return false;
    state.pendingDraft = null;
    window.dispatchEvent(new Event('tesla-host:draft-consumed'));
    showMessage($('deployBotMessage'), 'Your setup draft is loaded in this protected review. No session has been sent yet; review the app name and resources, then select Deploy Now.', 'success');
    updateDeployReady();
    return true;
  }

  function clearManifestCredentials() {
    for (const [key, field] of state.fields) {
      if (key === 'SESSION' || key === 'DEV' || field.type === 'password') field.value = '';
    }
  }

  async function deployBot() {
    if (!state.password || !state.manifest || state.busy) return;
    updateDeployReady();
    if ($('deployBotButton').disabled) return;
    const env = {};
    for (const [key, field] of state.fields) env[key] = field.value;
    const body = {
      repoUrl: $('repoUrl').value.trim(),
      commitSha: state.manifest.commitSha,
      appName: $('botAppName').value.trim(),
      env,
      confirmResources: $('confirmResources').checked
    };
    const button = $('deployBotButton');
    state.busy = true;
    state.deploying = true;
    button.disabled = true;
    showMessage($('deployBotMessage'), 'Submitting the app setup to Heroku. Sensitive values are sent only for this request…');
    try {
      const result = await request('/deploy', { method: 'POST', body });
      state.setup = result.setup;
      clearManifestCredentials();
      state.pendingDraft = null;
      window.dispatchEvent(new Event('tesla-host:draft-consumed'));
      $('setupResult').hidden = false;
      $('setupAppName').textContent = result.setup.appName || body.appName;
      updateSetup(result.setup);
      showMessage($('deployBotMessage'), 'Heroku accepted the setup request. Refresh status to follow the build.', 'success');
      await refreshBots();
    } catch (error) {
      showMessage($('deployBotMessage'), error.message, 'error');
    } finally {
      state.busy = false;
      state.deploying = false;
      updateDeployReady();
    }
  }

  function updateSetup(setup) {
    state.setup = setup;
    $('setupStatus').textContent = String(setup.status || 'unknown').replaceAll('_', ' ').toUpperCase();
    $('setupStatus').dataset.status = setup.status || 'unknown';
    $('setupResultMessage').textContent = setup.failureMessage || (setup.status === 'succeeded'
      ? 'Heroku reports the setup succeeded.'
      : setup.status === 'failed'
        ? 'The setup failed. Check the Heroku Dashboard for build details.'
        : 'Heroku is setting up the app.');
    const appUrl = safeHerokuUrl(setup.appUrl);
    const link = $('setupAppLink');
    link.hidden = !appUrl;
    if (appUrl) link.href = appUrl;
    $('checkSetupButton').hidden = !setup.id || setup.status === 'succeeded' || setup.status === 'failed';
  }

  async function checkSetup() {
    if (!state.password || !state.setup || !state.setup.id || state.busy) return;
    const button = $('checkSetupButton');
    setBusy(button, true, 'Check setup status');
    showMessage($('setupResultMessage'), 'Checking Heroku…');
    try {
      const result = await request(`/setups/${encodeURIComponent(state.setup.id)}`);
      updateSetup(result.setup);
      if (result.setup.status === 'succeeded') await refreshBots();
    } catch (error) {
      showMessage($('setupResultMessage'), error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  async function login(event) {
    event.preventDefault();
    const passwordInput = $('adminPassword');
    if (!passwordInput.value) return;
    state.password = passwordInput.value;
    showMessage($('adminLoginMessage'), 'Checking the Heroku connection…');
    $('adminLoginButton').disabled = true;
    try {
      const result = await request('/account');
      if (!result.connected) throw new Error('Heroku connection is not available.');
      $('adminLoginCard').hidden = true;
      $('adminConsole').hidden = false;
      passwordInput.value = '';
      showMessage($('adminLoginMessage'), '');
      await refreshBots();
      if (state.pendingDraft) await inspectRepositoryValue(state.pendingDraft.repoUrl);
    } catch (error) {
      state.password = null;
      passwordInput.value = '';
      showMessage($('adminLoginMessage'), error.message, 'error');
    } finally {
      $('adminLoginButton').disabled = false;
    }
  }

  $('adminLoginForm').addEventListener('submit', login);
  $('adminLogout').addEventListener('click', logout);
  $('refreshBots').addEventListener('click', refreshBots);
  $('repoForm').addEventListener('submit', inspectRepository);
  $('deployBotButton').addEventListener('click', deployBot);
  $('checkSetupButton').addEventListener('click', checkSetup);
  $('confirmResources').addEventListener('change', updateDeployReady);
  $('botAppName').addEventListener('input', updateDeployReady);
  $('repoUrl').value = 'https://github.com/ignatiusmkuu-spec/Tesla-bot';

  window.addEventListener('tesla-host:deploy-draft', (event) => {
    const source = event.detail;
    if (!source || typeof source !== 'object' || typeof source.repoUrl !== 'string' || typeof source.appName !== 'string' || !source.env || typeof source.env !== 'object') return;
    let repositoryUrl;
    try {
      repositoryUrl = new URL(source.repoUrl);
    } catch {
      return;
    }
    if (repositoryUrl.protocol !== 'https:' || repositoryUrl.hostname !== 'github.com' || repositoryUrl.username || repositoryUrl.password) return;
    const env = {};
    for (const key of ['APP_NAME', 'DEV', 'MENU_TYPE', 'BAD_WORD', 'SESSION']) {
      if (typeof source.env[key] === 'string') env[key] = source.env[key].trim();
    }
    if (!validAppName(source.appName) || env.APP_NAME !== source.appName || !/^\d+(?:,\d+)*$/.test(env.DEV || '') || !['VIDEO', 'LINK', 'IMAGE'].includes(env.MENU_TYPE) || validateSession(env.SESSION || '')) return;
    state.pendingDraft = { repoUrl: repositoryUrl.href, appName: source.appName, env };
    event.preventDefault();
    $('repoUrl').value = repositoryUrl.href;
    window.location.hash = 'admin';
    $('admin').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (state.password) {
      void inspectRepositoryValue(repositoryUrl.href);
    } else {
      $('adminPassword').focus({ preventScroll: true });
    }
  });

  window.addEventListener('tesla-host:draft-cancelled', (event) => {
    event.preventDefault();
    if (state.deploying) {
      showMessage($('deployBotMessage'), 'Heroku has already received this deploy request; clearing the local form cannot recall it.', 'error');
      return;
    }
    state.pendingDraft = null;
    for (const key of ['SESSION', 'DEV']) {
      const field = state.fields.get(key);
      if (field) field.value = '';
    }
    updateDeployReady();
    showMessage($('deployBotMessage'), 'The staged session and owner number were cleared from this tab. Nothing was submitted to Heroku.', 'success');
  });

  window.addEventListener('pagehide', () => {
    state.password = null;
    clearSecretInputs();
  });
})();
