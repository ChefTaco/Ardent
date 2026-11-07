#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Publishes @hivemagnus/ardent with provenance when its version is not on npm yet.
// A dry run packs and validates without registry access; a real publication must run from
// the matching vX.Y.Z tag and authenticates through npm trusted publishing (OIDC).

export function readReleasePackage(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@hivemagnus/ardent' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')
    || pkg.private || pkg.publishConfig?.access !== 'public') {
    throw new Error('package.json must be the public @hivemagnus/ardent package with a valid version');
  }
  return pkg;
}

export async function publishedVersionExists(name, version, fetcher = fetch) {
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Could not check ${name}@${version} on npm (HTTP ${response.status}); publication stopped`);
  const metadata = await response.json();
  if (metadata.name !== name || metadata.version !== version) throw new Error(`Unexpected npm metadata for ${name}@${version}; publication stopped`);
  return true;
}

export async function publishPackage({ root, dryRun, ref, fetcher = fetch, run = execFileSync }) {
  if (typeof dryRun !== 'boolean') throw new Error('An explicit boolean dryRun is required');
  const pkg = readReleasePackage(root);
  if (!dryRun && ref !== `refs/tags/v${pkg.version}`) throw new Error('Real publication must run from the matching release tag');
  // A registry or authentication failure must not be mistaken for an unpublished version.
  if (!dryRun && await publishedVersionExists(pkg.name, pkg.version, fetcher)) {
    console.log(`${pkg.name}@${pkg.version} is already on npm; skipping`);
    return;
  }
  // The payload was built, tested and inspected by the gates; never run lifecycle scripts here.
  run('npm', ['publish', dryRun ? '--dry-run' : '--provenance', '--ignore-scripts', '--access', 'public',
    '--registry', 'https://registry.npmjs.org/'], { cwd: root, stdio: 'inherit' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!['true', 'false'].includes(process.env.DRY_RUN)) throw new Error('DRY_RUN must be true or false');
    await publishPackage({ root: resolve(import.meta.dirname, '..'), dryRun: process.env.DRY_RUN === 'true', ref: process.env.GITHUB_REF });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
