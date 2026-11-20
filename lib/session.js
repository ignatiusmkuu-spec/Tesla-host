'use strict';

const REQUIRED_CREDENTIAL_KEYS = [
  'noiseKey',
  'signedIdentityKey',
  'signedPreKey',
  'registrationId',
  'advSecretKey'
];

function validateSession(value) {
  if (typeof value !== 'string' || value.length > 250_000) {
    return { valid: false, message: 'Enter a complete session value under 250 KB.' };
  }

  let text = value.trim().replace(/^['"]+|['"]+$/g, '').trim();
  if (!text) return { valid: false, message: 'A WhatsApp session is required.' };
  text = text.replace(/^[A-Za-z0-9_-]{1,32}:~/, '');

  let jsonText = text;
  if (!text.startsWith('{')) {
    let base64 = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      return { valid: false, message: 'The session format is not supported.' };
    }
    const unpadded = base64.replace(/=+$/, '');
    if (unpadded.length % 4 === 1) {
      return { valid: false, message: 'The session appears incomplete.' };
    }
    base64 = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
    try {
      jsonText = Buffer.from(base64, 'base64').toString('utf8');
    } catch {
      return { valid: false, message: 'The session could not be decoded.' };
    }
  }

  let credentials;
  try {
    credentials = JSON.parse(jsonText);
  } catch {
    return { valid: false, message: 'The session is not valid JSON or is incomplete.' };
  }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    return { valid: false, message: 'The session does not contain WhatsApp credentials.' };
  }
  if (REQUIRED_CREDENTIAL_KEYS.some((key) => !(key in credentials))) {
    return { valid: false, message: 'The session is missing required WhatsApp credential fields.' };
  }
  return { valid: true };
}

module.exports = { validateSession };
