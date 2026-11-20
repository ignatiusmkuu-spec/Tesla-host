(() => {
  'use strict';

  const REPO_TEMPLATE = 'https://github.com/ignatiusmkuu-spec/Tesla-bot/tree/main';
  const $ = (id) => document.getElementById(id);
  const fields = {
    appName: $('appName'),
    ownerNumbers: $('ownerNumbers'),
    menuType: $('menuType'),
    badWords: $('badWords'),
    sessionValue: $('sessionValue')
  };
  const errors = {
    appName: $('appNameError'),
    ownerNumbers: $('ownerError'),
    sessionValue: $('sessionError')
  };
  let toastTimer;

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3000);
  }

  function setError(fieldName, message) {
    const field = fields[fieldName];
    if (!field || !errors[fieldName]) return;
    errors[fieldName].textContent = message;
    field.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function sessionValidationMessage(value) {
    let text = String(value || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
    if (!text) return 'Paste the full WhatsApp session from the pairing site.';
    text = text.replace(/^[A-Za-z0-9_-]{1,32}:~/, '');

    let json = text;
    if (!text.startsWith('{')) {
      const base64 = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        return 'This session has characters the bot cannot read. Copy the complete value from the pairing site.';
      }
      const unpadded = base64.replace(/=+$/, '');
      if (unpadded.length % 4 === 1) {
        return 'This session looks incomplete. Copy the complete value from the pairing site.';
      }
      const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
      try {
        const binary = window.atob(padded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        json = new TextDecoder().decode(bytes);
      } catch {
        return 'The session could not be decoded. Generate a fresh session and copy it in full.';
      }
    }

    let credentials;
    try {
      credentials = JSON.parse(json);
    } catch {
      return 'The session looks cut off or changed. Copy the full session value again.';
    }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      return 'This does not look like a WhatsApp credentials session. Generate a new session.';
    }
    const requiredKeys = ['noiseKey', 'signedIdentityKey', 'signedPreKey', 'registrationId', 'advSecretKey'];
    const missing = requiredKeys.filter((key) => !(key in credentials));
    if (missing.length) {
      return `This is not a complete WhatsApp session (missing ${missing.join(', ')}). Generate a new session.`;
    }
    return '';
  }

  function validateField(name) {
    const value = fields[name].value.trim();
    if (name === 'appName') {
      if (!value) return setError(name, 'Enter an app name to continue.'), false;
      if (!/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(value)) {
        return setError(name, 'Use 3–30 lowercase letters, numbers, or internal hyphens. Start with a letter and end with a letter or number.'), false;
      }
      setError(name, '');
      return true;
    }
    if (name === 'ownerNumbers') {
      if (!value) return setError(name, 'Enter at least one owner phone number.'), false;
      if (!/^\d+(?:,\d+)*$/.test(value)) {
        return setError(name, 'Use digits only and separate multiple numbers with commas. Do not include + signs or spaces.'), false;
      }
      setError(name, '');
      return true;
    }
    if (name === 'sessionValue') {
      const message = sessionValidationMessage(value);
      setError(name, message);
      return !message;
    }
    return true;
  }

  function validateAll() {
    const required = ['appName', 'ownerNumbers', 'sessionValue'];
    let valid = true;
    for (const name of required) valid = validateField(name) && valid;
    if (!valid) {
      const firstInvalid = required.map((name) => fields[name]).find((field) => field.getAttribute('aria-invalid') === 'true');
      if (firstInvalid) {
        firstInvalid.focus();
        firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    return valid;
  }

  function stageToTeslaHost() {
    const draft = {
      repoUrl: REPO_TEMPLATE,
      appName: fields.appName.value.trim(),
      env: {
        APP_NAME: fields.appName.value.trim(),
        DEV: fields.ownerNumbers.value.trim(),
        MENU_TYPE: fields.menuType.value,
        BAD_WORD: fields.badWords.value.trim(),
        SESSION: fields.sessionValue.value.trim()
      }
    };
    if (!draft.env.BAD_WORD) delete draft.env.BAD_WORD;

    const handled = !window.dispatchEvent(new CustomEvent('tesla-host:deploy-draft', {
      detail: draft,
      cancelable: true
    }));
    if (!handled) {
      showToast('The protected Tesla Host deploy panel is unavailable. Your values are still in this page.');
      return false;
    }

    $('deployState').textContent = 'DRAFT STAGED';
    $('deployState').style.color = 'var(--cyan)';
    const message = $('deployMessage');
    message.style.color = 'var(--mint)';
    message.textContent = 'Draft staged in this tab only. Sign in to the Tesla Host admin panel, review the repository and charges, then select Deploy Now. No session has been sent to Tesla Host yet.';
    window.location.hash = 'admin';
    $('admin').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if ($('adminPassword').getClientRects().length) $('adminPassword').focus({ preventScroll: true });
    return true;
  }

  async function copyText(value, label) {
    if (!value) {
      showToast(`Add ${label.toLowerCase()} before copying.`);
      return false;
    }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const temporary = document.createElement('textarea');
        temporary.value = value;
        temporary.setAttribute('readonly', '');
        temporary.style.position = 'fixed';
        temporary.style.opacity = '0';
        document.body.appendChild(temporary);
        temporary.select();
        const copied = document.execCommand('copy');
        temporary.remove();
        if (!copied) throw new Error('Clipboard access was blocked.');
      }
      showToast(`${label} copied. Use it only in Tesla Host's protected deploy review; clear it from your clipboard when done.`);
      return true;
    } catch {
      showToast('Clipboard access was blocked. Select and copy the value manually when needed.');
      return false;
    }
  }

  function updateSummary() {
    const nameOkay = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(fields.appName.value.trim());
    const ownerOkay = /^\d+(?:,\d+)*$/.test(fields.ownerNumbers.value.trim());
    const sessionOkay = sessionValidationMessage(fields.sessionValue.value) === '';
    const values = [nameOkay, ownerOkay, sessionOkay, true];
    const complete = values.filter(Boolean).length;
    $('deployButton').disabled = !(nameOkay && ownerOkay && sessionOkay);
    $('completionText').textContent = `${complete} / 4`;
    $('completionBar').style.width = `${complete * 25}%`;
    $('reqAppName').classList.toggle('ready', nameOkay);
    $('reqOwner').classList.toggle('ready', ownerOkay);
    $('reqSession').classList.toggle('ready', sessionOkay);
    $('appNameCount').textContent = `${fields.appName.value.length} / 30`;
    $('prefsChecklist').textContent = nameOkay ? 'READY' : 'EDIT';
    $('prefsChecklist').style.color = nameOkay ? 'var(--mint)' : '';
    $('configState').textContent = nameOkay && ownerOkay && sessionOkay ? 'READY' : 'WAITING';
    $('configState').style.color = nameOkay && ownerOkay && sessionOkay ? 'var(--mint)' : '';
    $('pairingState').textContent = sessionOkay ? 'SESSION ADDED' : 'NEXT';
    $('pairingState').style.color = sessionOkay ? 'var(--mint)' : '';
  }

  for (const name of ['appName', 'ownerNumbers', 'sessionValue']) {
    fields[name].addEventListener('input', () => {
      if (fields[name].getAttribute('aria-invalid') === 'true') validateField(name);
      updateSummary();
    });
    fields[name].addEventListener('blur', () => {
      if (fields[name].value.trim()) validateField(name);
    });
  }
  fields.menuType.addEventListener('change', updateSummary);
  fields.badWords.addEventListener('input', updateSummary);
  $('settingsForm').addEventListener('submit', (event) => event.preventDefault());

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => {
      const fieldName = button.dataset.copy;
      const label = fieldName === 'sessionValue' ? 'WhatsApp session' : 'Owner phone number';
      void copyText(fields[fieldName].value.trim(), label);
    });
  });

  $('clearSession').addEventListener('click', () => {
    fields.sessionValue.value = '';
    window.dispatchEvent(new Event('tesla-host:draft-cancelled'));
    setError('sessionValue', '');
    updateSummary();
    showToast('Session cleared from this page.');
  });

  $('deployButton').addEventListener('click', () => {
    const message = $('deployMessage');
    message.replaceChildren();
    if (!validateAll()) return;
    stageToTeslaHost();
  });

  document.querySelectorAll('[data-pair-link]').forEach((link) => {
    link.addEventListener('click', () => {
      $('pairingState').textContent = 'LINK OPENED';
      $('pairingState').style.color = 'var(--cyan)';
    });
  });

  const sectionLinks = document.querySelectorAll('.nav-link');
  if ('IntersectionObserver' in window) {
    const sectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        sectionLinks.forEach((link) => link.classList.toggle('active', link.hash === `#${entry.target.id}`));
      }
    }, { rootMargin: '-20% 0px -68% 0px' });
    ['overview', 'pairing', 'configuration', 'deployment'].forEach((id) => {
      const section = $(id);
      if (section) sectionObserver.observe(section);
    });
  }

  window.addEventListener('tesla-host:draft-consumed', () => {
    for (const field of [fields.appName, fields.ownerNumbers, fields.sessionValue]) {
      field.value = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    updateSummary();
  });

  updateSummary();
})();
