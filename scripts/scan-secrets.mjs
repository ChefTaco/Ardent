#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { privateInfrastructureFindings, secretFindings } from './privacy-policy.mjs';

const root = resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const staged = process.argv.includes('--staged');
if (process.argv.slice(2).some(arg => arg !== '--staged')) throw new Error('Usage: scan-secrets.sh [--staged]');
const files = git(...(staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
  : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).toString().split('\0').filter(Boolean);
let failures = 0;
for (const file of new Set(files)) {
  // Tracked build output must be checked too; ignore rules exclude untracked build products.
  if (!staged && !existsSync(resolve(root, file))) continue;
  const content = staged ? git('show', `:${file}`) : readFileSync(resolve(root, file));
  for (const finding of [...secretFindings(content.toString()), ...privateInfrastructureFindings(content.toString())]) {
    console.error(`${file}:${finding.line}: ${finding.rule} [redacted]`);
    failures++;
  }
}
if (!staged) {
  // A sanitized working copy must not hide a secret in the index from the commit hook.
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'scan-secrets.mjs'), '--staged'],
    { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) failures++;
}
if (failures) process.exitCode = 1;
else console.log(`Secret scan passed (${staged ? 'staged' : 'working'} files).`);
