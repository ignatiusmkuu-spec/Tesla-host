'use strict';

const GITHUB_API = 'https://api.github.com';
const SAFE_ENV_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const SENSITIVE_KEY = /(?:SESSION|TOKEN|SECRET|PASSWORD|CREDENTIAL|(?:^|_)KEY(?:_|$)|HEROKU_API)/i;
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PART = /^[A-Za-z0-9._/-]{1,200}$/;

class RepositoryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RepositoryError';
    this.status = status;
  }
}

function parseRepositoryInput(input) {
  if (typeof input !== 'string' || input.length > 512) {
    throw new RepositoryError('Enter a public GitHub repository URL or owner/repository.');
  }
  let value = input.trim();
  if (!value) throw new RepositoryError('Enter a public GitHub repository URL or owner/repository.');
  if (!value.includes('://')) value = `https://github.com/${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RepositoryError('Enter a valid GitHub repository URL.');
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
    throw new RepositoryError('For this release, use a public repository hosted on github.com without query parameters.');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || !REPO_PART.test(parts[0]) || !REPO_PART.test(parts[1])) {
    throw new RepositoryError('Use a repository URL in the form github.com/owner/repository.');
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!repo || !REPO_PART.test(repo)) throw new RepositoryError('The repository name is invalid.');

  let branch = null;
  if (parts.length > 2) {
    if (parts[2] !== 'tree' || parts.length < 4) {
      throw new RepositoryError('To select a branch, use the /tree/branch portion of the repository URL.');
    }
    branch = parts.slice(3).join('/');
    if (!BRANCH_PART.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
      throw new RepositoryError('The branch name is invalid.');
    }
  }
  return { owner, repo, branch };
}

async function githubJson(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Tesla-Host/1.0'
      },
      signal: AbortSignal.timeout(12_000),
      redirect: 'error'
    });
  } catch {
    throw new RepositoryError('Could not reach GitHub. Try again later.', 502);
  }
  if (response.status === 404) throw new RepositoryError('Repository or root app.json not found. Confirm the repository is public.', 404);
  if (response.status === 403 || response.status === 429) throw new RepositoryError('GitHub rate-limited this check. Wait briefly and try again.', 429);
  if (!response.ok) throw new RepositoryError('GitHub could not read this repository.', 502);
  return response.json();
}

function cleanString(value, maxLength = 240) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLength);
}

function parseAddons(addons) {
  if (!Array.isArray(addons)) return [];
  return addons.slice(0, 32).map((addon) => {
    if (typeof addon === 'string') return addon.trim().slice(0, 180);
    if (addon && typeof addon === 'object') {
      return typeof addon.plan === 'string' ? addon.plan.trim().slice(0, 180) : '';
    }
    return '';
  }).filter((value) => /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,179}$/.test(value));
}

function parseBuildpacks(buildpacks) {
  if (!Array.isArray(buildpacks)) return [];
  return buildpacks.slice(0, 16).map((buildpack) => {
    if (typeof buildpack === 'string') return cleanString(buildpack, 220);
    if (!buildpack || typeof buildpack !== 'object') return '';
    const name = typeof buildpack.name === 'string' ? cleanString(buildpack.name, 120) : '';
    const rawUrl = typeof buildpack.url === 'string' ? buildpack.url : '';
    if (!rawUrl) return name;
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:' || url.username || url.password) return name || 'Unrecognized buildpack URL';
      return name ? `${name} — ${url.hostname}${url.pathname}` : `${url.hostname}${url.pathname}`;
    } catch {
      return name || cleanString(rawUrl, 120);
    }
  }).filter(Boolean);
}

function makeFormSchema(manifest) {
  const sourceEnv = manifest && manifest.env && typeof manifest.env === 'object' && !Array.isArray(manifest.env)
    ? manifest.env
    : {};
  const addons = parseAddons(manifest && manifest.addons);
  const fields = [];
  const generated = [];
  const skipped = [];
  const blocked = [];
  const hasSession = Object.prototype.hasOwnProperty.call(sourceEnv, 'SESSION');
  const hasDatabaseAddon = addons.some((addon) => /(?:^|:)heroku-postgresql(?::|$)/i.test(addon));

  for (const [key, rawSpec] of Object.entries(sourceEnv).slice(0, 100)) {
    if (!SAFE_ENV_KEY.test(key)) continue;
    const spec = rawSpec && typeof rawSpec === 'object' && !Array.isArray(rawSpec) ? rawSpec : {};
    const description = cleanString(spec.description, 320);
    const sensitive = SENSITIVE_KEY.test(key);
    if (key === 'APP_NAME') {
      skipped.push({ key, reason: 'Filled from the selected Heroku app name.' });
      continue;
    }
    if (key === 'HEROKU_API') {
      skipped.push({ key, reason: 'Tesla Host never forwards its account API credential to a bot.' });
      if (spec.required !== false && !spec.generator && !Object.prototype.hasOwnProperty.call(spec, 'value')) blocked.push(key);
      continue;
    }
    if (key === 'DATABASE_URL') {
      skipped.push({ key, reason: 'Supplied automatically by Heroku Postgres when present.' });
      if (spec.required !== false && !hasDatabaseAddon && !Object.prototype.hasOwnProperty.call(spec, 'value')) blocked.push(key);
      continue;
    }
    if (spec.generator === 'secret') {
      generated.push({ key, description: description || 'Generated by Heroku during setup.' });
      continue;
    }

    const field = {
      key,
      description,
      required: spec.required !== false,
      sensitive,
      type: key === 'MENU_TYPE' ? 'menu' : (key === 'SESSION' ? 'session' : (sensitive ? 'password' : 'text'))
    };
    if (!sensitive && (typeof spec.value === 'string' || typeof spec.value === 'number' || typeof spec.value === 'boolean')) {
      field.defaultValue = String(spec.value).slice(0, 1000);
    }
    fields.push(field);
  }

  const postdeploy = manifest && manifest.scripts && typeof manifest.scripts.postdeploy === 'string'
    ? cleanString(manifest.scripts.postdeploy, 400)
    : '';
  return {
    name: cleanString(manifest && manifest.name, 120),
    description: cleanString(manifest && manifest.description, 240),
    addons,
    buildpacks: parseBuildpacks(manifest && manifest.buildpacks),
    postdeploy,
    fields,
    generated,
    skipped,
    blocked,
    hasSession
  };
}

async function inspectRepository(input) {
  const parsed = parseRepositoryInput(input);
  const repoUrl = `${GITHUB_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  const repository = await githubJson(repoUrl);
  if (repository.private === true) {
    throw new RepositoryError('Private repositories are not supported by this public-tarball deployment flow.', 400);
  }
  const defaultBranch = typeof repository.default_branch === 'string' ? repository.default_branch : '';
  const branch = parsed.branch || defaultBranch;
  if (!BRANCH_PART.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    throw new RepositoryError('GitHub returned a branch name this setup flow cannot safely use.', 400);
  }

  const commitsUrl = new URL(`${GITHUB_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits`);
  commitsUrl.searchParams.set('sha', branch);
  commitsUrl.searchParams.set('per_page', '1');
  const commits = await githubJson(commitsUrl.toString());
  const commitSha = Array.isArray(commits) && commits[0] && typeof commits[0].sha === 'string'
    ? commits[0].sha
    : '';
  if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) {
    throw new RepositoryError('Could not resolve this GitHub branch to a valid commit.', 422);
  }

  const manifestUrl = `${GITHUB_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/contents/app.json?ref=${encodeURIComponent(commitSha)}`;
  const manifestFile = await githubJson(manifestUrl);
  if (!manifestFile || typeof manifestFile.content !== 'string' || manifestFile.encoding !== 'base64') {
    throw new RepositoryError('The repository root app.json is not a readable file.', 422);
  }
  const manifestBuffer = Buffer.from(manifestFile.content.replace(/\s+/g, ''), 'base64');
  if (manifestBuffer.length > 64 * 1024) throw new RepositoryError('The repository app.json is too large to inspect.', 413);

  let manifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf8'));
  } catch {
    throw new RepositoryError('The repository app.json is not valid JSON.', 422);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new RepositoryError('The repository app.json must contain a JSON object.', 422);
  }

  const info = makeFormSchema(manifest);
  const tarballUrl = `https://github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/tarball/${encodeURIComponent(commitSha)}`;
  return {
    repository: `${parsed.owner}/${parsed.repo}`,
    repositoryUrl: `https://github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    branch,
    commitSha,
    tarballUrl,
    manifest: info
  };
}

module.exports = { RepositoryError, inspectRepository, makeFormSchema, parseRepositoryInput };
