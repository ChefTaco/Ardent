import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Magnus adopts newer context maintenance onto an installed older runtime by overlaying these
// modules; they then load that runtime's own base modules. Those base modules must only be asked
// for exports that every supported release already has.
const overlay = ['src/context.ts', 'src/context-checkpoints.ts', 'src/context-maintenance.ts', 'src/sqlite.ts'];
const stableExports: Record<string, string[]> = {
  './store.js': ['TaskStore'],
  './config.js': ['loadConfig'],
  './model-policy.js': ['loadModelPolicy', 'parseModelPolicy'],
  './codex.js': ['compactWithCodex'],
};
const overlaid = new Set(overlay.map(path => `./${path.slice('src/'.length).replace(/\.ts$/, '.js')}`));

describe('context overlay imports', () => {
  it('imports only exports that older runtimes provide', async () => {
    for (const path of overlay) {
      const source = await readFile(path, 'utf8');
      for (const match of source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+'(\.\/[^']+)';/gm)) {
        const [, typeOnly, names, from] = match;
        if (typeOnly || overlaid.has(from!)) continue;
        const values = names!.split(',').map(name => name.trim()).filter(name => name && !name.startsWith('type '));
        expect(stableExports[from!], `${path} imports from ${from}`).toBeDefined();
        for (const name of values) expect(stableExports[from!], `${path} imports ${name} from ${from}`).toContain(name);
      }
      expect(source, `${path} uses a default or namespace import from a base module`).not.toMatch(/^import\s+(\w+|\*\s+as\s+\w+)\s+from\s+'\.\//m);
    }
  });
});
