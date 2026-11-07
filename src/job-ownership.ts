import type { JobDefinition, OwnershipCheck } from './job-engine.js';

/**
 * Default ownership policy: an enabled job explicitly assigned to Ardent may
 * run. Deployments that migrate schedules from another scheduler can add a
 * stricter check through a plugin (`ArdentPlugin.jobOwnership`).
 */
export async function assertJobOwnership(job: JobDefinition): Promise<void> {
  if (!job.enabled || job.owner !== 'ardent') throw new Error('Job is not assigned to Ardent');
}

/** Combine the default policy with optional extra checks; every check must pass. */
export function composeOwnershipChecks(extra: readonly OwnershipCheck[] = []): OwnershipCheck {
  return async (job, now) => {
    await assertJobOwnership(job);
    for (const check of extra) await check(job, now);
  };
}
