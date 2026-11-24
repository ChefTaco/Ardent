import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { publishedVersionExists, publishPackage, publishRelease } from './publish-package.mjs';

function releaseFixture(t, manifest = {}, client) {
  const root = mkdtempSync(join(tmpdir(), 'ardent-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@hivemagnus/ardent', version: '1.0.1', publishConfig: { access: 'public' }, ...manifest,
  }));
  mkdirSync(join(root, 'client'));
  writeFileSync(join(root, 'client/package.json'), JSON.stringify({
    name: '@hivemagnus/ardent-client', version: '1.0.1', publishConfig: { access: 'public' }, ...client,
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
  // The client publishes after the runtime, from the same job, environment and tag.
  assert.deepEqual(steps.slice(-2).map(step => step.run), ['node scripts/publish-package.mjs runtime', 'node scripts/publish-package.mjs client']);
  assert.ok(steps.some(step => step.run?.includes('npm run verify')));
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

test('one tag publishes the runtime and then the client, each skipped when already on npm', async t => {
  const root = releaseFixture(t);
  const calls = [];
  const lookups = [];
  const run = (...args) => calls.push(args[2].cwd);
  const published = new Set(['@hivemagnus/ardent']);
  const fetcher = async url => {
    lookups.push(url);
    const name = decodeURIComponent(url.split('/')[3]);
    return published.has(name) ? Response.json({ name, version: '1.0.1' }) : new Response('', { status: 404 });
  };
  await publishRelease({ root, dryRun: false, ref: 'refs/tags/v1.0.1', run, fetcher });
  assert.deepEqual(lookups, ['https://registry.npmjs.org/%40hivemagnus%2Fardent/1.0.1', 'https://registry.npmjs.org/%40hivemagnus%2Fardent-client/1.0.1']);
  assert.deepEqual(calls, [join(root, 'client')]);
  calls.length = 0;
  await publishRelease({ root, dryRun: true, ref: 'refs/heads/main', run, fetcher: () => { throw new Error('unexpected registry lookup'); } });
  assert.deepEqual(calls, [root, join(root, 'client')]);
  calls.length = 0;
  await publishRelease({ root, dryRun: true, only: 'client', run });
  assert.deepEqual(calls, [join(root, 'client')]);
  await assert.rejects(publishRelease({ root, dryRun: true, only: 'docs', run }), /Unknown release package/);
});

test('a client that does not carry the runtime version stops the whole release', async t => {
  const run = () => assert.fail('npm must not run');
  await assert.rejects(publishRelease({ root: releaseFixture(t, {}, { version: '1.0.0' }), dryRun: true, run }), /different versions/);
  await assert.rejects(publishRelease({ root: releaseFixture(t, {}, { version: '1.0.0' }), dryRun: true, only: 'runtime', run }), /different versions/);
  await assert.rejects(publishRelease({ root: releaseFixture(t, {}, { name: '@example/other' }), dryRun: true, run }), /public @hivemagnus\/ardent-client/);
  await assert.rejects(publishRelease({ root: releaseFixture(t, {}, { private: true }), dryRun: true, run }), /public @hivemagnus\/ardent-client/);
});

test('the workflow documents the trusted publisher the client needs', () => {
  const text = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  assert.ok(text.includes('npm trust github @hivemagnus/ardent-client --file publish.yml --repo ChefTaco/Ardent --env npm-publish --allow-publish'));
});
