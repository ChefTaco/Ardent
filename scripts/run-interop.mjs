#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageDir = resolve(import.meta.dirname, '..');
const cache = resolve(packageDir, 'node_modules/.cache/ardent-a2a-python');
const legacyCache = resolve(packageDir, 'node_modules/.cache/ardent-a2a-python-v03');
const hermesCache = resolve(packageDir, 'node_modules/.cache/ardent-hermes-upstream');
const hermesSource = process.env.ARDENT_HERMES_SOURCE ?? hermesCache;
const hermesRevision = 'fef0bc56b2f622ffe124835fbf57adfd10aa17e6';
const python = process.env.ARDENT_A2A_PYTHON ?? join(cache, 'bin', 'python');
const legacyPython = process.env.ARDENT_A2A_PYTHON_V03 ?? join(legacyCache, 'bin', 'python');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}`);
}

if (!process.env.ARDENT_A2A_PYTHON && !existsSync(python)) {
  mkdirSync(cache, { recursive: true });
  const venv = spawnSync('python3', ['-m', 'venv', cache], { stdio: 'pipe' });
  if (venv.status !== 0) {
    run('python3', ['-m', 'venv', '--without-pip', cache]);
    const bootstrap = join(cache, 'get-pip.py');
    run('curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', '30', 'https://bootstrap.pypa.io/get-pip.py', '--output', bootstrap]);
    run(python, [bootstrap, '--quiet']);
  }
}
if (!process.env.ARDENT_A2A_PYTHON) {
  const installed = spawnSync(python, ['-c', 'import importlib.metadata, grpc, starlette, uvicorn, yaml; assert importlib.metadata.version("a2a-sdk") == "1.0.3"; assert importlib.metadata.version("uvicorn") == "0.30.6"; assert importlib.metadata.version("PyYAML") == "6.0.3"'], { stdio: 'ignore' });
  if (installed.status !== 0) run(join(cache, 'bin', 'pip'), ['install', '--disable-pip-version-check', 'a2a-sdk[grpc,http-server]==1.0.3', 'uvicorn==0.30.6', 'PyYAML==6.0.3']);
}
if (!process.env.ARDENT_A2A_PYTHON_V03 && !existsSync(legacyPython)) {
  mkdirSync(legacyCache, { recursive: true });
  run('python3', ['-m', 'venv', '--without-pip', legacyCache]);
}
if (!process.env.ARDENT_A2A_PYTHON_V03) {
  const installed = spawnSync(legacyPython, ['-c', 'import importlib.metadata, starlette, uvicorn; assert importlib.metadata.version("a2a-sdk") == "0.3.26"; assert importlib.metadata.version("uvicorn") == "0.30.6"'], { stdio: 'ignore' });
  if (installed.status !== 0) run(join(cache, 'bin', 'pip'), ['--python', legacyCache, 'install', '--disable-pip-version-check', 'a2a-sdk[http-server]==0.3.26', 'uvicorn==0.30.6']);
}
if (!process.env.ARDENT_HERMES_SOURCE) {
  if (!existsSync(join(hermesSource, '.git'))) {
    run('git', ['clone', '--filter=blob:none', 'https://github.com/NousResearch/hermes-agent.git', hermesSource]);
  }
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: hermesSource, encoding: 'utf8' });
  if (revision.status !== 0 || revision.stdout.trim() !== hermesRevision) {
    run('git', ['fetch', '--depth=1', 'origin', hermesRevision], { cwd: hermesSource });
    run('git', ['checkout', '--detach', hermesRevision], { cwd: hermesSource });
  }
}
run('npm', ['run', 'interop:test'], { cwd: packageDir, env: { ...process.env, ARDENT_A2A_PYTHON: python, ARDENT_A2A_PYTHON_V03: legacyPython, ARDENT_HERMES_SOURCE: hermesSource } });
