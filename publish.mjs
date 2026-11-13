#!/usr/bin/env node
/**
 * One-shot publisher: creates the GitHub repo (if missing) and pushes `main`.
 *
 *   PowerShell:  $env:GITHUB_TOKEN = "<your PAT with repo scope>"; node publish.mjs
 *   bash:        GITHUB_TOKEN=<pat> node publish.mjs
 *
 * The token is read from the environment and handed to git through a transient
 * -c http.extraheader, so it is never written to .git/config, never echoed, and
 * never appears in this script's output.
 */
import { spawnSync } from 'node:child_process';

const REPO = process.env.GITHUB_REPO || 'mcp-task-board';
const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
const DESCRIPTION =
  'A dependency-aware task board for heterogeneous AI agents: atomic claims, leases, capability routing, artifacts, MCP server + CLI, zero dependencies.';

if (!token) {
  console.error('GITHUB_TOKEN is not set. See PUBLISH.md for the three ways to publish.');
  process.exit(1);
}

const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mcp-task-board-publisher',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text };
};

const fail = (message) => {
  console.error(`publish: ${message}`);
  process.exit(1);
};

let owner = process.env.GITHUB_OWNER;
if (!owner) {
  const me = await api('GET', '/user');
  if (me.status !== 200) fail(`cannot read /user (HTTP ${me.status}). Check the token scope.`);
  owner = me.json.login;
}

const existing = await api('GET', `/repos/${owner}/${REPO}`);
if (existing.status === 404) {
  const created = await api('POST', '/user/repos', {
    name: REPO,
    description: DESCRIPTION,
    private: false,
    has_issues: true,
    has_wiki: false,
    auto_init: false,
  });
  if (created.status !== 201) fail(`create repo failed (HTTP ${created.status}): ${created.text.slice(0, 300)}`);
  console.log(`created https://github.com/${owner}/${REPO}`);
} else if (existing.status === 200) {
  console.log(`repo exists: https://github.com/${owner}/${REPO}`);
} else {
  fail(`cannot check repo (HTTP ${existing.status})`);
}

const remote = `https://github.com/${owner}/${REPO}.git`;
const git = (args) => spawnSync('git', args, { encoding: 'utf8' });
const remotes = git(['remote']).stdout.split(/\r?\n/).filter(Boolean);
git(remotes.includes('origin') ? ['remote', 'set-url', 'origin', remote] : ['remote', 'add', 'origin', remote]);

const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
const push = spawnSync('git', ['-c', `http.extraheader=Authorization: Basic ${basic}`, 'push', '-u', 'origin', 'main'], {
  stdio: 'inherit',
});
if (push.status !== 0) fail('git push failed (see output above; no secrets were printed)');

console.log(`\npushed. https://github.com/${owner}/${REPO}`);
console.log('next: enable Actions (already configured), add topics, and pin the repo.');
