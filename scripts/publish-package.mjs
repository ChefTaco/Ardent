#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Publishes @hivemagnus/ardent and then @hivemagnus/ardent-client (client/) with provenance when
// their version is not on npm yet. Both carry the same version and publish from the same tag.
// A dry run packs and validates without registry access; a real publication must run from the
// matching vX.Y.Z tag and authenticates through npm trusted publishing (OIDC).

/** The packages one release tag publishes, in order: the client after the runtime it talks to. */
export const RELEASE_PACKAGES = [
  { id: 'runtime', name: '@hivemagnus/ardent', dir: '.' },
  { id: 'client', name: '@hivemagnus/ardent-client', dir: 'client' },
];

export function readReleasePackage(root, name = '@hivemagnus/ardent') {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== name || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')
    || pkg.private || pkg.publishConfig?.access !== 'public') {
    throw new Error(`package.json must be the public ${name} package with a valid version`);
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

export async function publishPackage({ root, dryRun, ref, name = '@hivemagnus/ardent', fetcher = fetch, run = execFileSync }) {
  if (typeof dryRun !== 'boolean') throw new Error('An explicit boolean dryRun is required');
  const pkg = readReleasePackage(root, name);
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

/**
 * Publish the selected release packages (all by default, in order). Every package must carry
 * the runtime's version before anything is published, so one tag never releases half a pair.
 */
export async function publishRelease({ root, dryRun, ref, only, fetcher = fetch, run = execFileSync }) {
  const packages = RELEASE_PACKAGES.filter(item => only === undefined || item.id === only);
  if (!packages.length) throw new Error(`Unknown release package ${only}; use ${RELEASE_PACKAGES.map(item => item.id).join(' or ')}`);
  const versions = RELEASE_PACKAGES.map(item => readReleasePackage(join(root, item.dir), item.name).version);
  if (new Set(versions).size !== 1) throw new Error(`Release packages carry different versions (${versions.join(', ')}); run npm run release:version`);
  for (const item of packages) await publishPackage({ root: join(root, item.dir), name: item.name, dryRun, ref, fetcher, run });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!['true', 'false'].includes(process.env.DRY_RUN)) throw new Error('DRY_RUN must be true or false');
    await publishRelease({ root: resolve(import.meta.dirname, '..'), dryRun: process.env.DRY_RUN === 'true', ref: process.env.GITHUB_REF, only: process.argv[2] });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
