// Bootstrap the native runtime with the protected environment before Node reads
// startup-only settings such as NODE_EXTRA_CA_CERTS. No shell evaluation.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { readProtectedFile } from './acceptance.js';

try {
  const args = process.argv.slice(2);
  const index = args.indexOf('--env-file');
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (index >= 0) {
    const file = args[index + 1];
    if (!file) throw new Error('A protected environment file is required');
    for (const [name, value] of Object.entries(parse(await readProtectedFile(file))))
      if (env[name] === undefined) env[name] = value;
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), ...args],
    { env, stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  child.on('error', () => { process.stderr.write('Ardent native process could not start\n'); process.exitCode = 1; });
  child.on('close', (code) => {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
    process.exitCode = code ?? 1;
  });
} catch {
  process.stderr.write('Ardent native environment could not be loaded from an owned private file\n');
  process.exitCode = 1;
}
