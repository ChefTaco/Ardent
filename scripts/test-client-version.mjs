import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { checkClientVersion } from './check-client-version.mjs';

const root = resolve(import.meta.dirname, '..');
const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'));

function fixture(t, edit = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ardent-client-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'client'));
  const files = { runtime: read('package.json'), client: read('client/package.json'), lock: read('package-lock.json'), license: readFileSync(join(root, 'LICENSE'), 'utf8') };
  edit(files);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(files.runtime));
  writeFileSync(join(dir, 'client/package.json'), JSON.stringify(files.client));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(files.lock));
  writeFileSync(join(dir, 'LICENSE'), readFileSync(join(root, 'LICENSE'), 'utf8'));
  writeFileSync(join(dir, 'client/LICENSE'), files.license);
  return dir;
}

test('the repository keeps the runtime and the client on one version', () => {
  assert.equal(checkClientVersion(root), read('package.json').version);
});

test('a client version, lockfile or manifest that drifts fails the check', t => {
  assert.throws(() => checkClientVersion(fixture(t, files => { files.client.version = '0.0.1'; })), /differs from Ardent/);
  assert.throws(() => checkClientVersion(fixture(t, files => { files.runtime.version = '99.0.0'; })), /differs from Ardent/);
  assert.throws(() => checkClientVersion(fixture(t, files => { files.lock.packages.client.version = '0.0.1'; })), /package-lock/);
  assert.throws(() => checkClientVersion(fixture(t, files => { files.client.dependencies.zod = '^4.0.0'; })), /hive-common only/);
  assert.throws(() => checkClientVersion(fixture(t, files => { files.client.files.push('src'); })), /client files/);
  assert.throws(() => checkClientVersion(fixture(t, files => { files.client.sideEffects = true; })), /side effects/);
  assert.throws(() => checkClientVersion(fixture(t, files => { files.client.engines = { node: '>=18' }; })), /engines/);
  assert.throws(() => checkClientVersion(fixture(t, files => { files.license = 'MIT'; })), /LICENSE/);
});

test('the release version script bumps the root and the workspace together', () => {
  const script = read('package.json').scripts['release:version'];
  assert.match(script, /^npm version --no-git-tag-version --workspaces --include-workspace-root$/);
});
