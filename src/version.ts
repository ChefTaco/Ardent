import { readFileSync } from 'node:fs';
import { z } from 'zod';

const metadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const ARDENT_VERSION = z.object({ name: z.literal('@hivemagnus/ardent'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/) }).parse(metadata).version;
