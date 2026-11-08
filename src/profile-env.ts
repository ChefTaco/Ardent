import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { readProtectedFile } from './acceptance.js';

/**
 * Parse the profile environment file: an explicit file must be an owned private
 * file, the default `<profile>/.env` may be absent. Values never leave the process.
 */
export async function readProfileEnv(dir: string, explicitFile?: string): Promise<Record<string, string>> {
  try { return parse(explicitFile ? await readProtectedFile(explicitFile) : await readFile(join(dir, '.env'))); }
  catch (error: unknown) {
    if (explicitFile || !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    return {};
  }
}
