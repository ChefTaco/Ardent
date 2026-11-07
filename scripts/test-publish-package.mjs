import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { publishedVersionExists, publishPackage } from './publish-package.mjs';

function releaseFixture(t, manifest = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ardent-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@hivemagnus/ardent', version: '1.0.1', publishConfig: { access: 'public' }, ...manifest,
  }));
  return root;
}

test('only an explicit 404 means a version is absent; other registry failures stop publication', async () => {
  assert.equal(await publishedVersionExists('@example/package', '1.0.1', async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/%40example%2Fpackage/1.0.1');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
    return new Response('', { status: 404 });
  }), false);
  assert.equal(await publishedVersionExists('@example/package', '1.0.1', async () =>
    Response.json({ name: '@example/package', version: '1.0.1' })), true);
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(publishedVersionExists('@example/package', '1.0.1', async () => new Response('', { status })), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(publishedVersionExists('@example/package', '1.0.1', async () => Response.json({})), /Unexpected npm metadata/);
  await assert.rejects(publishedVersionExists('@example/package', '1.0.1', async () => { throw new Error('connection failed'); }), /connection failed/);
});

test('the workflow publishes only from the protected environment, with OIDC and no stored npm credential', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.publish;
  assert.equal(job.environment, 'npm-publish');
  assert.equal(job.permissions['id-token'], 'write');
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  const steps = job.steps;
  assert.equal(steps.at(-1).run, 'node scripts/publish-package.mjs');
  assert.ok(steps.some(step => step.run === 'node scripts/check-publish-environment.mjs' && step.if === "env.DRY_RUN != 'true'"));
  assert.ok(!JSON.stringify(workflow).includes('secrets.'));
});

test('real publication requires the version tag and a definite registry answer before publishing', async t => {
  const root = releaseFixture(t);
  let publications = 0;
  const run = () => { publications++; };
  await assert.rejects(publishPackage({ root, dryRun: false, ref: 'refs/heads/main', run }), /matching release tag/);
  await assert.rejects(publishPackage({ root, dryRun: false, ref: 'refs/tags/v1.0.0', run }), /matching release tag/);
  await assert.rejects(publishPackage({ root, dryRun: false, ref: 'refs/tags/v1.0.1', run,
    fetcher: async () => new Response('', { status: 503 }) }), /HTTP 503/);
  assert.equal(publications, 0);
});

test('dry runs validate the package without registry access or provenance publication', async t => {
  const root = releaseFixture(t);
  const calls = [];
  await publishPackage({ root, dryRun: true, ref: 'refs/heads/main', fetcher: () => { throw new Error('unexpected registry lookup'); },
    run: (...args) => calls.push(args) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['publish', '--dry-run', '--ignore-scripts', '--access', 'public', '--registry', 'https://registry.npmjs.org/']);
  assert.equal(calls[0][2].cwd, root);
});

test('real publication skips an existing version and otherwise publishes with provenance', async t => {
  const root = releaseFixture(t);
  const calls = [];
  const run = (...args) => calls.push(args);
  await publishPackage({ root, dryRun: false, ref: 'refs/tags/v1.0.1', run,
    fetcher: async () => Response.json({ name: '@hivemagnus/ardent', version: '1.0.1' }) });
  assert.equal(calls.length, 0);
  await publishPackage({ root, dryRun: false, ref: 'refs/tags/v1.0.1', run, fetcher: async () => new Response('', { status: 404 }) });
  assert.equal(calls.length, 1);
  assert.ok(calls[0][1].includes('--provenance'));
});

test('package metadata mismatches stop before calling npm', async t => {
  const options = root => ({ root, dryRun: true, run: () => assert.fail('npm must not run') });
  await assert.rejects(publishPackage(options(releaseFixture(t, { private: true }))), /public @hivemagnus\/ardent/);
  await assert.rejects(publishPackage(options(releaseFixture(t, { publishConfig: {} }))), /public @hivemagnus\/ardent/);
  await assert.rejects(publishPackage(options(releaseFixture(t, { name: '@example/other' }))), /public @hivemagnus\/ardent/);
  await assert.rejects(publishPackage(options(releaseFixture(t, { version: 'next' }))), /valid version/);
  await assert.rejects(publishPackage({ root: releaseFixture(t), dryRun: undefined }), /explicit boolean/);
});
