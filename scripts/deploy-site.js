'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HerokuApiError, herokuRequest } = require('../lib/heroku-client');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const NAME_PATTERN = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;
const CONFIRM_FLAG = '--confirm-basic-dyno-cost-usd-7-month';
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const BUILD_FILES = [
  'app.json',
  'Dockerfile',
  'Procfile',
  'README.md',
  'lib',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'public',
  'scripts',
  'server.js'
];
const USAGE = [
  'Tesla Host Heroku deploy operator',
  '',
  'Read-only availability check:',
  '  pnpm deploy:heroku --app-name tesla-host-site --dry-run',
  '',
  'Create, build, and scale one live Basic web dyno (up to US$7/month at 24/7 usage):',
  `  pnpm deploy:heroku --app-name tesla-host-site ${CONFIRM_FLAG}`,
  '',
  'Required server environment: HEROKU_API_KEY and TESLA_HOST_ADMIN_PASSWORD.'
].join('\n');

function parseOptions(argv) {
  const options = { appName: null, costConfirmed: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--app-name') {
      options.appName = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (argument === CONFIRM_FLAG) {
      options.costConfirmed = true;
      continue;
    }
    throw new Error(`Unsupported option: ${argument}`);
  }
  if (options.help) return options;
  if (!options.appName || !NAME_PATTERN.test(options.appName)) {
    throw new Error('Choose a 3–30 character Heroku app slug: lowercase letters, digits, and internal hyphens; start with a letter.');
  }
  if (options.dryRun && options.costConfirmed) {
    throw new Error('Use either --dry-run or the cost-approval flag, not both.');
  }
  if (!options.dryRun && !options.costConfirmed) {
    throw new Error(`No deployment was started. Review the Basic dyno cost (up to US$7/month at continuous usage) and re-run with ${CONFIRM_FLAG} only after approval.`);
  }
  return options;
}

function requireProtectedValues() {
  if (!process.env.HEROKU_API_KEY || !process.env.TESLA_HOST_ADMIN_PASSWORD) {
    throw new Error('Missing protected runtime configuration. Set HEROKU_API_KEY and TESLA_HOST_ADMIN_PASSWORD in the server secret store.');
  }
}

async function checkNameAvailableInAccount(appName) {
  try {
    await herokuRequest(`/apps/${encodeURIComponent(appName)}`);
    return false;
  } catch (error) {
    if (error instanceof HerokuApiError && error.status === 404) return true;
    throw error;
  }
}

function makeSourceArchive() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tesla-host-heroku-'));
  const archivePath = path.join(directory, 'source.tgz');
  try {
    execFileSync('tar', ['-czf', archivePath, '-C', PROJECT_ROOT, ...BUILD_FILES], {
      stdio: 'ignore',
      timeout: 120_000
    });
    const stats = fs.statSync(archivePath);
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_ARCHIVE_BYTES) {
      throw new Error('The generated source archive is empty or larger than the 100 MiB safety limit.');
    }
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    return { directory, archivePath, checksum };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function ensureHttpsUrl(value) {
  if (typeof value !== 'string') throw new Error('Heroku did not return the required signed source URL.');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Heroku returned a source URL that did not pass HTTPS validation.');
  }
  return value;
}

async function uploadArchive(putUrl, archivePath) {
  const response = await fetch(ensureHttpsUrl(putUrl), {
    method: 'PUT',
    body: fs.readFileSync(archivePath),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error('Heroku source upload failed. Check the app in Heroku before retrying.');
}

function safeBuildStatus(build) {
  return build && typeof build.status === 'string' ? build.status.toLowerCase() : 'unknown';
}

async function waitForBuild(appName, buildId) {
  const attempts = 180;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const build = await herokuRequest(`/apps/${encodeURIComponent(appName)}/builds/${encodeURIComponent(buildId)}`);
    const status = safeBuildStatus(build);
    if (status === 'successful' || status === 'succeeded') return;
    if (status === 'failed') throw new Error('Heroku reports that the build failed. Inspect its build output in the Heroku Dashboard.');
    if (status !== 'pending' && status !== 'unknown') {
      throw new Error(`Heroku returned an unexpected build state (${status}). Check the app in the Heroku Dashboard.`);
    }
    if (attempt % 6 === 5) console.log('Heroku build is still running…');
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error('The Heroku build is still pending after 15 minutes. Check its status in the Heroku Dashboard.');
}

async function deploy(options) {
  requireProtectedValues();
  const available = await checkNameAvailableInAccount(options.appName);
  if (!available) throw new Error(`The app name ${options.appName} is already used in this Heroku account. Choose a different name.`);
  if (options.dryRun) {
    console.log(`Read-only check complete: ${options.appName} is not visible in the connected Heroku account. Heroku confirms global name availability only during creation; no app or resource was created.`);
    return;
  }

  const archive = makeSourceArchive();
  let appCreated = false;
  try {
    console.log(`Creating Heroku app ${options.appName}…`);
    const app = await herokuRequest('/apps', {
      method: 'POST',
      body: { name: options.appName }
    });
    appCreated = true;

    console.log('Setting protected server config vars…');
    await herokuRequest(`/apps/${encodeURIComponent(options.appName)}/config-vars`, {
      method: 'PATCH',
      body: {
        HEROKU_API_KEY: process.env.HEROKU_API_KEY,
        TESLA_HOST_ADMIN_PASSWORD: process.env.TESLA_HOST_ADMIN_PASSWORD
      }
    });

    console.log('Requesting a temporary private-source upload URL…');
    const source = await herokuRequest(`/apps/${encodeURIComponent(options.appName)}/sources`, { method: 'POST' });
    const sourceBlob = source && source.source_blob;
    if (!sourceBlob || typeof sourceBlob.put_url !== 'string' || typeof sourceBlob.get_url !== 'string') {
      throw new Error('Heroku did not return the expected signed source upload details.');
    }
    const getUrl = ensureHttpsUrl(sourceBlob.get_url);
    await uploadArchive(sourceBlob.put_url, archive.archivePath);

    console.log('Starting the Heroku build…');
    const build = await herokuRequest(`/apps/${encodeURIComponent(options.appName)}/builds`, {
      method: 'POST',
      body: { source_blob: { url: getUrl, checksum: `SHA256:${archive.checksum}` } }
    });
    if (!build || typeof build.id !== 'string') throw new Error('Heroku did not return a build ID. Check the app in the Heroku Dashboard.');
    await waitForBuild(options.appName, build.id);

    console.log('Scaling one web process to the Basic dyno size approved for this deployment…');
    await herokuRequest(`/apps/${encodeURIComponent(options.appName)}/formation/web`, {
      method: 'PATCH',
      body: { dyno_size: { name: 'basic' }, quantity: 1 }
    });

    const appUrl = typeof app.web_url === 'string' && app.web_url.startsWith('https://')
      ? app.web_url
      : `https://${options.appName}.herokuapp.com`;
    console.log(`Heroku reports the build succeeded. App: ${appUrl}`);
    console.log('The app uses one Basic dyno (up to US$7/month at continuous runtime, before tax).');
  } catch (error) {
    if (appCreated) console.error(`Heroku may have created ${options.appName}; check its state before retrying. Tesla Host does not delete apps automatically.`);
    throw error;
  } finally {
    fs.rmSync(archive.directory, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  requireProtectedValues();
  await deploy(options);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof HerokuApiError ? error.message : String(error && error.message || 'Deployment failed.');
    console.error(message);
    process.exitCode = 1;
  });
}

module.exports = { CONFIRM_FLAG, NAME_PATTERN, parseOptions };
