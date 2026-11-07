import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(join(root, 'protocol', 'lock.json'), 'utf8'));
const proto = await readFile(join(root, 'protocol', 'a2a.proto'));
const digest = createHash('sha256').update(proto).digest('hex');
if (digest !== lock.protobuf_sha256) throw new Error(`A2A protobuf digest mismatch: ${digest}`);
const require = createRequire(import.meta.url);
const sdkEntry = require.resolve('@a2a-js/sdk');
const sdkPackage = JSON.parse(await readFile(join(dirname(sdkEntry), '..', 'package.json'), 'utf8'));
if (`${sdkPackage.name}@${sdkPackage.version}` !== lock.protocol_library) throw new Error('A2A SDK version does not match protocol lock');
process.stdout.write(`A2A ${lock.specification}, ${lock.protocol_library}, protobuf ${digest}\n`);
