'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { CONFIRM_FLAG, parseOptions } = require('../scripts/deploy-site');

test('help is available without credentials or deployment approval', () => {
  assert.deepEqual(parseOptions(['--help']), {
    appName: null,
    costConfirmed: false,
    dryRun: false,
    help: true
  });
});

test('live deployment is refused unless the exact Basic-dyno cost flag is present', () => {
  assert.throws(() => parseOptions(['--app-name', 'tesla-host-site']), /No deployment was started/);
  assert.equal(CONFIRM_FLAG, '--confirm-basic-dyno-cost-usd-7-month');
});

test('a read-only dry run accepts a valid Heroku app slug without granting deployment approval', () => {
  assert.deepEqual(parseOptions(['--app-name', 'tesla-host-site', '--dry-run']), {
    appName: 'tesla-host-site',
    costConfirmed: false,
    dryRun: true,
    help: false
  });
});

test('invalid names and accidental confirmation plus dry-run combinations are refused', () => {
  assert.throws(() => parseOptions(['--app-name', 'Tesla Host', CONFIRM_FLAG]), /app slug/);
  assert.throws(() => parseOptions(['--app-name', 'tesla-host-site', '--dry-run', CONFIRM_FLAG]), /either --dry-run or the cost-approval flag/);
});

test('a live deployment is accepted by the parser only with a valid slug and exact approval', () => {
  assert.deepEqual(parseOptions(['--app-name', 'tesla-host-site', CONFIRM_FLAG]), {
    appName: 'tesla-host-site',
    costConfirmed: true,
    dryRun: false,
    help: false
  });
});
