import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'ardent-package-check-'));
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd: root, timeout: 180_000, maxBuffer: 64 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${command} ${args[0] ?? ''} failed: ${String(stderr).slice(-2000) || error.message}`));
    else resolve(String(stdout));
  });
});
/**
 * Pack @hivemagnus/ardent-client, install the tarball in a disposable prefix, import it in Node,
 * compile a TypeScript consumer against its types, and bundle it for the browser.
 */
async function checkClient(version) {
  const clientDir = join(root, 'client');
  await run('npm', ['run', 'client:build']);
  const listing = JSON.parse(await run('npm', ['pack', '--dry-run', '--json', '--silent'], { cwd: clientDir, maxBuffer: 8 * 1024 * 1024 }));
  const files = listing[0].files.map(file => file.path);
  const allowed = [/^dist\/[A-Za-z0-9._-]+\.(?:js|d\.ts)$/, /^README\.md$/, /^LICENSE$/, /^NOTICE$/, /^package\.json$/];
  const unexpected = files.filter(path => !allowed.some(pattern => pattern.test(path)));
  if (unexpected.length) throw new Error(`Unexpected packed client files: ${unexpected.join(', ')}`);
  for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/generated.d.ts', 'README.md', 'LICENSE', 'NOTICE'])
    if (!files.includes(required)) throw new Error(`Packed client file missing: ${required}`);
  const filename = (await run('npm', ['pack', '--pack-destination', temporary, '--silent'], { cwd: clientDir })).trim().split('\n').at(-1);
  if (!filename || !/^hivemagnus-ardent-client-[0-9][A-Za-z0-9.-]*\.tgz$/.test(filename)) throw new Error('Client pack did not produce the expected tarball');
  const install = join(temporary, 'client-install');
  await run('npm', ['install', '--prefix', install, '--omit=dev', '--no-audit', '--no-fund', '--no-save', join(temporary, filename)], { timeout: 5 * 60_000 });
  const packageDir = join(install, 'node_modules/@hivemagnus/ardent-client');
  if (!(await realpath(packageDir)).startsWith(`${install}/`)) throw new Error('Installed client package resolves outside the disposable prefix');
  const installed = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  if (installed.name !== '@hivemagnus/ardent-client' || installed.version !== version) throw new Error('Installed client identity differs from Ardent');
  const scoped = await readdir(join(install, 'node_modules/@hivemagnus'));
  if (JSON.stringify(scoped.sort()) !== JSON.stringify(['ardent-client', 'hive-common'])) throw new Error(`Client installs unexpected @hivemagnus packages: ${scoped.join(', ')}`);
  for (const file of files.filter(path => path.endsWith('.js'))) {
    if (/\bfrom\s*["']node:|\bimport\(\s*["']node:|\brequire\(/.test(await readFile(join(packageDir, file), 'utf8'))) throw new Error(`Client ${file} uses a Node built-in`);
  }
  await run(process.execPath, ['--input-type=module', '-e', [
    "const c = await import('@hivemagnus/ardent-client');",
    "for (const name of ['createArdentClient','direct','viaMagnus','ArdentClientError','UnauthorizedError','NotFoundError','ConflictError','UnsupportedCapabilityError','TransportError','DigestMismatchError'])",
    "  if (typeof c[name] !== 'function') throw Error('Missing export ' + name);",
    "const fetch = async (url, init) => new Headers(init.headers).get('authorization') === 'Bearer fixture-token' && url === 'http://ardent.example.com/api/v1/status'",
    "  ? Response.json({ version: 'x', profile: 'assistant', backend: 'llamacpp', tasks: 0, channels: { mattermost: { catchup: [] } }, capabilities: { artifact_transfer: 2 } })",
    "  : new Response('', { status: 404 });",
    "const client = c.createArdentClient({ transport: c.direct({ baseUrl: 'http://ardent.example.com', getToken: () => 'fixture-token', fetch }) });",
    "if ((await client.capabilities()).features.artifactContent !== true) throw Error('Installed client did not read capabilities');",
    "const error = await client.tasks.get('00000000-0000-4000-8000-000000000000').catch(e => e);",
    "if (!(error instanceof c.NotFoundError)) throw Error('Installed client did not map a 404');",
  ].join('\n')], { cwd: install });
  await writeFile(join(install, 'consumer.ts'), [
    "import { createArdentClient, viaMagnus, type Task, type Recovery } from '@hivemagnus/ardent-client';",
    "const client = createArdentClient({ transport: viaMagnus({ baseUrl: 'https://magnus.example.com', nodeId: 'node', profile: 'assistant', getToken: () => 'fixture-token' }) });",
    "export const task: Promise<Task> = client.tasks.follow('id', { onText: text => { void text.text; } });",
    "export const recovery: Promise<Recovery | null> = client.recovery.get('id');",
  ].join('\n'));
  await writeFile(join(install, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    exactOptionalPropertyTypes: true, noEmit: true, types: [], lib: ['ES2022', 'DOM', 'DOM.Iterable', 'DOM.AsyncIterable'] }, files: ['consumer.ts'] }));
  await run(join(root, 'node_modules/.bin/tsc'), ['-p', join(install, 'tsconfig.json')]);
  const bundle = await build({ entryPoints: [join(packageDir, 'dist/index.js')], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent' });
  const builtins = Object.keys(bundle.metafile.inputs).filter(input => input.startsWith('node:'));
  if (builtins.length) throw new Error(`Client browser bundle pulls in Node built-ins: ${builtins.join(', ')}`);
  return { package: filename, files: files.length, version: installed.version, node: 'ok', types: 'ok', browserBundleBytes: bundle.outputFiles[0].contents.length };
}

try {
  await run('npm', ['run', 'build']);
  // The published file list is an allowlist: runtime code, the neutral
  // example profile, protocol pins, model-policy defaults, README and LICENSE.
  const listing = JSON.parse(await run('npm', ['pack', '--dry-run', '--json', '--silent'], { maxBuffer: 8 * 1024 * 1024 }));
  const files = listing[0].files.map(file => file.path);
  const allowed = [/^dist\/[A-Za-z0-9._-]+\.(?:js|d\.ts)$/, /^profiles\/assistant\//, /^protocol\//,
    /^model-policy\.default\.json$/, /^README\.md$/, /^LICENSE$/, /^package\.json$/];
  // Test files import devDependencies such as vitest; they never ship.
  const unexpected = files.filter(path => !allowed.some(pattern => pattern.test(path)) || /\.test\.(?:js|d\.ts)$/.test(path));
  if (unexpected.length) throw new Error(`Unexpected packed files: ${unexpected.join(', ')}`);
  for (const required of ['dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'dist/plugins.js', 'dist/plugin-sdk.js', 'dist/plugin-sdk.d.ts', 'dist/journal.js', 'dist/journal.d.ts', 'profiles/assistant/config.yaml',
    'protocol/LICENSE-A2A.txt', 'model-policy.default.json', 'README.md', 'LICENSE'])
    if (!files.includes(required)) throw new Error(`Packed file missing: ${required}`);
  const filename = (await run('npm', ['pack', '--pack-destination', temporary, '--silent'])).trim().split('\n').at(-1);
  if (!filename || !/^hivemagnus-ardent-[0-9][A-Za-z0-9.-]*\.tgz$/.test(filename)) throw new Error('Ardent pack did not produce the expected tarball');
  const install = join(temporary, 'install');
  await run('npm', ['install', '--prefix', install, '--omit=dev', '--no-audit', '--no-fund', '--no-save', join(temporary, filename)], { timeout: 5 * 60_000 });
  const packageDir = join(install, 'node_modules/@hivemagnus/ardent');
  const real = await realpath(packageDir);
  if (!real.startsWith(`${install}/`)) throw new Error('Installed Ardent package resolves outside the disposable prefix');
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  const sourcePackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (packageJson.name !== sourcePackage.name || packageJson.version !== sourcePackage.version)
    throw new Error('Installed package identity differs');
  await run(process.execPath, ['--input-type=module', '-e', "const sdk=await import('@hivemagnus/ardent/plugin-sdk');const db=new sdk.SqliteDatabase(':memory:');try{if(db.prepare('SELECT sqlite_version() AS version').get().version!=='3.54.1'||typeof sdk.loadPlugins!=='function')throw Error('Plugin SDK is unavailable')}finally{db.close()}"], { cwd: install });
  await run(process.execPath, ['--input-type=module', '-e', "const journal=await import('@hivemagnus/ardent/journal');if(journal.JOURNAL_POLICY_VERSION!==1||typeof journal.inspectJournal!=='function'||!journal.journalPolicy().tables.tasks)throw Error('Journal inspector is unavailable')"], { cwd: install });
  await run(process.execPath, ['-e', "const {DatabaseSync}=require(process.argv[1]);const db=new DatabaseSync(':memory:');if(db.prepare('select sqlite_version() v').get().v!=='3.54.1')throw Error('Unexpected embedded SQLite');db.close()", join(install, 'node_modules/@photostructure/sqlite')]);
  const env = { ...process.env, ARDENT_HOME: join(temporary, 'home') };
  const cli = join(packageDir, 'dist/cli.js');
  const initialized = JSON.parse(await run(process.execPath, [cli, 'init', '--profile', 'assistant', '--non-interactive'], { env }));
  if (initialized.profile !== 'assistant' || initialized.initialized !== true) throw new Error('Installed CLI did not initialize Assistant');
  const validation = JSON.parse(await run(process.execPath, [cli, 'config', 'validate', '--profile', 'assistant'], { env }));
  if (validation.valid !== true || !/^[a-f0-9]{64}$/.test(validation.revision)) throw new Error('Installed CLI did not validate its seeded profile');
  const client = await checkClient(sourcePackage.version);
  console.log(JSON.stringify({ package: filename, files: files.length, version: packageJson.version, nativeSqlite: 'ok', installedCli: 'ok', config: 'valid', client }));
} finally { await rm(temporary, { recursive: true, force: true }); }
