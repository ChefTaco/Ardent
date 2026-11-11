import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'ardent-package-check-'));
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd: root, timeout: 180_000, maxBuffer: 64 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${command} ${args[0] ?? ''} failed: ${String(stderr).slice(-2000) || error.message}`));
    else resolve(String(stdout));
  });
});
try {
  await run('npm', ['run', 'build']);
  // The published file list is an allowlist: runtime code, the neutral
  // example profile, protocol pins, model-policy defaults, README and LICENSE.
  const listing = JSON.parse(await run('npm', ['pack', '--dry-run', '--json', '--silent'], { maxBuffer: 8 * 1024 * 1024 }));
  const files = listing[0].files.map(file => file.path);
  const allowed = [/^dist\/[A-Za-z0-9._-]+\.(?:js|d\.ts)$/, /^profiles\/assistant\//, /^protocol\//,
    /^model-policy\.default\.json$/, /^README\.md$/, /^LICENSE$/, /^package\.json$/];
  const unexpected = files.filter(path => !allowed.some(pattern => pattern.test(path)));
  if (unexpected.length) throw new Error(`Unexpected packed files: ${unexpected.join(', ')}`);
  for (const required of ['dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'dist/plugins.js', 'dist/plugin-sdk.js', 'dist/plugin-sdk.d.ts', 'profiles/assistant/config.yaml',
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
  await run(process.execPath, ['-e', "const {DatabaseSync}=require(process.argv[1]);const db=new DatabaseSync(':memory:');if(db.prepare('select sqlite_version() v').get().v!=='3.54.1')throw Error('Unexpected embedded SQLite');db.close()", join(install, 'node_modules/@photostructure/sqlite')]);
  const env = { ...process.env, ARDENT_HOME: join(temporary, 'home') };
  const cli = join(packageDir, 'dist/cli.js');
  const initialized = JSON.parse(await run(process.execPath, [cli, 'init', '--profile', 'assistant', '--non-interactive'], { env }));
  if (initialized.profile !== 'assistant' || initialized.initialized !== true) throw new Error('Installed CLI did not initialize Assistant');
  const validation = JSON.parse(await run(process.execPath, [cli, 'config', 'validate', '--profile', 'assistant'], { env }));
  if (validation.valid !== true || !/^[a-f0-9]{64}$/.test(validation.revision)) throw new Error('Installed CLI did not validate its seeded profile');
  console.log(JSON.stringify({ package: filename, files: files.length, version: packageJson.version, nativeSqlite: 'ok', installedCli: 'ok', config: 'valid' }));
} finally { await rm(temporary, { recursive: true, force: true }); }
