import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublishEnvironment, checkPublishEnvironment } from './check-publish-environment.mjs';

const protectedEnvironment = { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 123 } }] }] };

test('publication requires an actual required reviewer rather than an environment name', () => {
  for (const value of [null, {}, { protection_rules: [] }, { protection_rules: [{ type: 'wait_timer' }] },
    { protection_rules: [{ type: 'required_reviewers', reviewers: [] }] }]) {
    assert.throws(() => assertPublishEnvironment(value), /required reviewer/);
  }
  assert.doesNotThrow(() => assertPublishEnvironment(protectedEnvironment));
});

test('GitHub environment checks fail closed and send the credential only to the API', async () => {
  const env = { GITHUB_REPOSITORY: 'example/ardent', GH_TOKEN: 'fixture-github-token' };
  await checkPublishEnvironment(env, async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/example/ardent/environments/npm-publish');
    assert.equal(options.headers.Authorization, 'Bearer fixture-github-token');
    assert.equal(options.redirect, 'error');
    return Response.json(protectedEnvironment);
  });
  await assert.rejects(checkPublishEnvironment(env, async () => new Response('', { status: 403 })), /HTTP 403/);
  await assert.rejects(checkPublishEnvironment(env, async () => Response.json({ protection_rules: [] })), /required reviewer/);
  await assert.rejects(checkPublishEnvironment({}), /required/);
});
