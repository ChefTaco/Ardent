#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// @hivemagnus/ardent-client (client/) is versioned and tagged with @hivemagnus/ardent: one vX.Y.Z tag
// publishes both. Bump them together with `npm run release:version -- X.Y.Z`.

const CLIENT_FILES = ['dist', 'README.md', 'LICENSE', 'NOTICE'];

/** Throws unless the runtime, the client and the lockfile agree on one version and the client manifest is publishable. */
export function checkClientVersion(root) {
  const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const runtime = read('package.json');
  const client = read('client/package.json');
  const lock = read('package-lock.json');
  const problems = [];
  if (client.name !== '@hivemagnus/ardent-client') problems.push('client/package.json must be @hivemagnus/ardent-client');
  if (client.version !== runtime.version) problems.push(`client version ${client.version} differs from Ardent ${runtime.version}; run npm run release:version -- ${runtime.version}`);
  if (lock.packages?.['']?.version !== runtime.version || lock.packages?.client?.version !== runtime.version)
    problems.push('package-lock.json versions differ from package.json; run npm install');
  if (!runtime.workspaces?.includes('client')) problems.push('package.json must list the client workspace');
  if (JSON.stringify(client.engines) !== JSON.stringify(runtime.engines)) problems.push('client engines differ from Ardent engines');
  if (client.license !== 'Apache-2.0' || client.type !== 'module' || client.sideEffects !== false || client.private || client.publishConfig?.access !== 'public')
    problems.push('client must be a public Apache-2.0 ESM package without side effects');
  if (JSON.stringify(client.files) !== JSON.stringify(CLIENT_FILES)) problems.push(`client files must be ${CLIENT_FILES.join(', ')}`);
  if (JSON.stringify(Object.keys(client.dependencies ?? {})) !== JSON.stringify(['@hivemagnus/hive-common']))
    problems.push('client runtime dependencies must be @hivemagnus/hive-common only');
  if (client.exports?.['.']?.types !== './dist/index.d.ts' || client.exports?.['.']?.default !== './dist/index.js') problems.push('client exports must map . to dist/index.js with types');
  if (readFileSync(join(root, 'client/LICENSE'), 'utf8') !== readFileSync(join(root, 'LICENSE'), 'utf8')) problems.push('client/LICENSE differs from LICENSE');
  if (problems.length) throw new Error(problems.join('\n'));
  return runtime.version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`@hivemagnus/ardent and @hivemagnus/ardent-client are both ${checkClientVersion(resolve(import.meta.dirname, '..'))}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
