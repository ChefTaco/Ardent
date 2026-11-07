import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { ardentOpenApi } from '../dist/api.js';

const target = resolve(import.meta.dirname, '../openapi/ardent.json');
// Types for the typed management client the tests use; consumers generate their own from the same document.
const generatedTypes = resolve(import.meta.dirname, '../test/generated/ardent-openapi.ts');
const generator = resolve(import.meta.dirname, '../node_modules/.bin/openapi-typescript');
const exec = promisify(execFile);
// openapi-typescript 7 runs on the archived @redocly/openapi-core 1.x, which only calls
// minimatch (as minimatch 5's callable export) to match resolve.http.headers from a Redocly
// config. The repo pins minimatch 11 everywhere (GHSA-g3hv-75wg-m249), so there must be no
// Redocly config next to the generator.
for (const name of ['redocly.yaml', '.redocly.yaml', 'redocly.yml', '.redocly.yml']) {
  const path = resolve(import.meta.dirname, '..', name);
  if (existsSync(path)) throw new Error(`${path}: a Redocly config is not supported by the pinned openapi-typescript toolchain`);
}
const document = ardentOpenApi();
await SwaggerParser.validate(document);
const operations = new Set();
for (const [path, methods] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    if (!['get', 'put', 'post', 'delete', 'patch'].includes(method)) continue;
    if (!operation.operationId || operations.has(operation.operationId)) throw new Error(`Missing or duplicate operationId at ${method.toUpperCase()} ${path}`);
    operations.add(operation.operationId);
    if (!operation.responses || !Object.keys(operation.responses).length) throw new Error(`Missing responses at ${method.toUpperCase()} ${path}`);
  }
}
const serialized = JSON.stringify(document, null, 2) + '\n';
if (process.argv.includes('--write')) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, serialized);
  await exec(generator, [target, '-o', generatedTypes], { timeout: 30_000 });
  process.stdout.write(`Wrote ${target} (${operations.size} operations)\n`);
} else {
  const committed = await readFile(target, 'utf8');
  if (committed !== serialized) throw new Error(`Ardent OpenAPI drift: run npm run openapi:write and review ${target}`);
  const dir = await mkdtemp(resolve(tmpdir(), 'ardent-openapi-'));
  try {
    const expectedTypes = resolve(dir, 'ardent-openapi.ts');
    await exec(generator, [target, '-o', expectedTypes], { timeout: 30_000 });
    if (await readFile(generatedTypes, 'utf8') !== await readFile(expectedTypes, 'utf8'))
      throw new Error(`Ardent typed client drift: run npm run openapi:write and review ${generatedTypes}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
  process.stdout.write(`Ardent OpenAPI 3.1 validated (${operations.size} operations)\n`);
}
