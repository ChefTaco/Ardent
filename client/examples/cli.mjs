#!/usr/bin/env node
// Submit a prompt to an Ardent profile, follow it to the end, and download its artifacts.
//
//   ARDENT_TOKEN=... node examples/cli.mjs --url http://127.0.0.1:9910 --prompt "Write the report" [--out ./downloads]
//   MAGNUS_TOKEN=... node examples/cli.mjs --magnus https://magnus.example.com --node <nodeId> --profile <profile> --prompt "..."
//   MAGNUS_TOKEN=... node examples/cli.mjs --magnus-api https://console.example.com/api/magnus --node <nodeId> --profile <profile> --prompt "..."
//
// --magnus is the Magnus origin (the client adds /api/v1); --magnus-api is the Magnus API root behind a
// proxy, such as a Hive console's /api/magnus.
//
// It prints the reply text as it streams to stderr and a JSON summary to stdout. The stream
// reconnects from its cursor when Ardent rotates it or the network drops it; downloads resume
// with Range and are verified against the artifact's SHA-256 before they are kept.
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createArdentClient, direct, viaMagnus } from '@hivemagnus/ardent-client';

function options(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid option ${key ?? ''}`);
    flags[key.slice(2)] = value;
  }
  if (!flags.prompt) throw new Error('--prompt is required');
  if ([flags.url, flags.magnus, flags['magnus-api']].filter(Boolean).length !== 1)
    throw new Error('Give either --url (standalone Ardent) or --magnus (or --magnus-api) with --node and --profile');
  return flags;
}

/** Run the example. Returns the summary it prints. */
export async function run({ argv = process.argv.slice(2), env = process.env, log = text => process.stderr.write(text), signal } = {}) {
  const flags = options(argv);
  const magnus = flags.magnus ? { baseUrl: flags.magnus } : flags['magnus-api'] ? { apiBase: flags['magnus-api'] } : undefined;
  const token = magnus ? env.MAGNUS_TOKEN : env.ARDENT_TOKEN;
  if (!token) throw new Error(magnus ? 'MAGNUS_TOKEN is required' : 'ARDENT_TOKEN is required');
  const getToken = () => token;
  const transport = magnus
    ? viaMagnus({ ...magnus, nodeId: flags.node, profile: flags.profile, getToken })
    : direct({ baseUrl: flags.url, getToken });
  const ardent = createArdentClient({ transport, ...(signal ? { signal } : {}) });

  const accepted = await ardent.tasks.submit({ prompt: flags.prompt, ...(flags.key ? { idempotencyKey: flags.key } : {}) });
  let reconnects = 0;
  let events = 0;
  let text = '';
  const task = await ardent.tasks.follow(accepted.task_id, {
    onConnect: (_cursor, reconnect) => { reconnects = reconnect; },
    onEvent: () => { events++; },
    onText: update => {
      if (update.kind === 'text') { log(update.text.slice(text.length)); text = update.text; }
      else { log(update.text); text += update.text; }
    },
  });
  log('\n');

  const downloads = [];
  if (task.state === 'completed' || task.state === 'partial') {
    const outDir = resolve(flags.out ?? '.');
    await mkdir(outDir, { recursive: true });
    for (const artifact of await ardent.artifacts.list(task.id)) {
      const sha = artifact.manifest.sha256;
      let resumes = 0;
      const download = await ardent.artifacts.download(sha, { onProgress: progress => { resumes = progress.resumes; } });
      // Write to a partial file and keep it only after the stream closed verified.
      const target = join(outDir, basename(download.filename ?? sha));
      const partial = `${target}.partial`;
      try {
        await download.stream.pipeTo(Writable.toWeb(createWriteStream(partial)));
        await rename(partial, target);
      } catch (error) {
        await rm(partial, { force: true });
        throw error;
      }
      downloads.push({ sha256: sha, size: download.size, path: target, resumes, verified: true });
    }
  }
  return { task_id: task.id, state: task.state, result: task.result, error: task.error, events, reconnects, downloads };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await run(), null, 2)}\n`); }
  catch (error) { console.error(`${error.name ?? 'Error'}: ${error.message}`); process.exitCode = 1; }
}
