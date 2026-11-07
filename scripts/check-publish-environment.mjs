#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function assertPublishEnvironment(value) {
  const rules = value?.protection_rules;
  if (!Array.isArray(rules) || !rules.some(rule => rule.type === 'required_reviewers'
    && Array.isArray(rule.reviewers) && rule.reviewers.some(reviewer =>
      ['User', 'Team'].includes(reviewer.type) && Number.isSafeInteger(reviewer.reviewer?.id) && reviewer.reviewer.id > 0))) {
    throw new Error('npm-publish must have at least one required reviewer configured in GitHub Settings > Environments before publishing');
  }
}

export async function checkPublishEnvironment(env = process.env, fetcher = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '') || !env.GH_TOKEN) {
    throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required to verify publication protection');
  }
  const response = await fetcher(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/environments/npm-publish`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Could not verify npm-publish environment protection (HTTP ${response.status})`);
  assertPublishEnvironment(await response.json());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkPublishEnvironment(); console.log('npm publication environment requires review.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
