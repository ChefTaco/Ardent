import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenPath, privateInfrastructureFindings, secretFindings } from './privacy-policy.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('blocks credential and local-state paths while allowing example configuration', () => {
  for (const path of ['.env.production', 'a/.npmrc', 'a/state/events.jsonl', 'artifacts/proof.json', 'a/private.key', 'data.sqlite-wal', 'AGENTS.local.md', '.hive-dev/config.json', '.ssh/id_ed25519', '.vscode/mcp.json']) {
    assert.equal(forbiddenPath(path), true, path);
  }
  for (const path of ['a/.env.example', 'a/README.md', 'src/state.ts']) assert.equal(forbiddenPath(path), false, path);
});

test('detects provider tokens even when unrelated text says example', () => {
  for (const token of ['npm_' + 'A'.repeat(36), 'ghp_' + 'B'.repeat(36), 'github_pat_' + 'C'.repeat(50),
    'sk-' + 'D'.repeat(30), 'AKIA' + 'E'.repeat(16), 'xoxb-' + '1234567890'.repeat(3)]) {
    const findings = secretFindings(`example: ${token}`);
    assert.ok(findings.length);
    assert.ok(!JSON.stringify(findings).includes(token));
  }
});

test('finds quoted credentials and only exempts the actual placeholder value', () => {
  const value = 'unrelated-opaque-' + 'A'.repeat(20);
  assert.ok(secretFindings(`API_SECRET="${value}" # example`).length);
  assert.ok(secretFindings(`{"SESSION_SECRET": "${value}"}`).length);
  assert.equal(secretFindings('API_SECRET="replace-with-a-random-secret"').length, 0);
  assert.equal(secretFindings('API_SECRET: process.env.API_SECRET').length, 0);
  assert.ok(secretFindings(`API_SECRET=${'A'.repeat(32)}`).length);
});

test('detects private-key headers without including their values in findings', () => {
  assert.equal(secretFindings('-----BEGIN ' + 'OPENSSH PRIVATE KEY-----')[0].rule, 'private key');
});

test('blocks private infrastructure patterns without an operator denylist', () => {
  const domain = ['node', 'private', 'ts', 'net'].join('.');
  assert.equal(privateInfrastructureFindings(`https://${domain}`).length, 1);
  assert.equal(privateInfrastructureFindings('/home/' + 'personal-account/project').length, 1);
  assert.equal(privateInfrastructureFindings('/home/operator/project https://node.example.com').length, 0);
});

test('the scanner checks staged blobs even when the working copy is sanitized', () => {
  const root = mkdtempSync(join(tmpdir(), 'ardent-secret-gate-'));
  try {
    mkdirSync(join(root, 'scripts'));
    for (const file of ['scan-secrets.mjs', 'privacy-policy.mjs']) {
      cpSync(resolve(import.meta.dirname, file), join(root, 'scripts', file));
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    const token = 'npm_' + 'Z'.repeat(36);
    const file = join(root, 'space in name.txt');
    writeFileSync(file, `example ${token}`);
    execFileSync('git', ['add', '--', 'space in name.txt'], { cwd: root });
    writeFileSync(file, 'sanitized working copy');
    const result = spawnSync(process.execPath, [join(root, 'scripts/scan-secrets.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm token \[redacted\]/);
    assert.ok(!`${result.stderr}${result.stdout}`.includes(token));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('private-data failures redact denied content and reject local-state files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ardent-private-gate-'));
  try {
    mkdirSync(join(root, 'scripts'));
    cpSync(resolve(import.meta.dirname, 'check-private-data.sh'), join(root, 'scripts/check-private-data.sh'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const privateTerm = 'private-' + 'fixture-name';
    writeFileSync(join(root, '.private-terms'), privateTerm);
    writeFileSync(join(root, 'notes.txt'), privateTerm);
    mkdirSync(join(root, 'state'));
    writeFileSync(join(root, 'state/events.jsonl'), '{}');
    execFileSync('git', ['add', 'notes.txt', 'state/events.jsonl'], { cwd: root });
    const result = spawnSync('bash', [join(root, 'scripts/check-private-data.sh'), '--staged'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /forbidden file: state\/events.jsonl/);
    assert.match(result.stderr, /notes.txt:1 \[redacted\]/);
    assert.ok(!result.stderr.includes(privateTerm));
    writeFileSync(join(root, '.private-terms'), '[');
    const invalid = spawnSync('bash', [join(root, 'scripts/check-private-data.sh')], { encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /invalid regular expression/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
