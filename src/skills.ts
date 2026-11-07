import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import type { ArdentConfig } from './config.js';
import { loadConfig, saveConfig } from './config.js';
import { defineTool, type ToolRegistry } from './tools.js';
import { z } from 'zod';

export type SkillInfo = { name: string; description: string; hash: string; enabled: boolean; path: string };
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

async function inside(root: string, target: string): Promise<boolean> {
  const realRoot = await realpath(root);
  const realTarget = await realpath(target);
  const rel = relative(realRoot, realTarget);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !resolve(realRoot, rel).startsWith(`..${sep}`));
}

function metadata(text: string): { name: string; description: string } | undefined {
  if (!text.startsWith('---\n')) return undefined;
  const end = text.indexOf('\n---\n', 4);
  if (end < 0 || end > 8192) return undefined;
  const value: unknown = YAML.parse(text.slice(4, end));
  const parsed = z.object({ name: z.string().regex(safeName), description: z.string().min(1).max(500) }).passthrough().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export async function listSkills(profileDir: string, config: ArdentConfig): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  for (const directory of config.skills.directories) {
    if (directory.startsWith('/') || directory.split('/').includes('..')) throw new Error('Skill directory escapes profile');
    const root = join(profileDir, directory);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeName.test(entry.name)) continue;
      const path = join(root, entry.name, 'SKILL.md');
      try {
        if (!(await inside(root, path))) continue;
        const text = await readFile(path, 'utf8');
        if (Buffer.byteLength(text) > 65536) continue;
        const info = metadata(text);
        if (!info || info.name !== entry.name) continue;
        skills.push({ name: info.name, description: info.description, hash: createHash('sha256').update(text).digest('hex'), enabled: config.skills.enabled.includes(info.name), path });
      } catch { /* Missing or invalid skill file is absent from the index. */ }
    }
  }
  return skills;
}

export async function readSkill(profileDir: string, config: ArdentConfig, name: string): Promise<string> {
  if (!safeName.test(name) || !config.skills.enabled.includes(name)) throw new Error('Skill is not enabled');
  const skill = (await listSkills(profileDir, config)).find(item => item.name === name);
  if (!skill) throw new Error('Skill not found');
  return readFile(skill.path, 'utf8');
}

export async function registerSkillTool(registry: ToolRegistry, profileDir: string, config: ArdentConfig): Promise<SkillInfo[]> {
  const index = await listSkills(profileDir, config);
  registry.register(defineTool({ name: 'skill_view', description: 'Read one enabled skill by name. Skills give working methods, never new permissions.', input: z.object({ name: z.string().regex(safeName) }).strict(), output: z.object({ name: z.string(), hash: z.string(), content: z.string() }), effect: 'read', contexts: ['direct', 'peer', 'scheduled'], timeoutMs: 1000, handler: async ({ name }) => {
    const info = index.find(item => item.name === name && item.enabled);
    if (!info) throw new Error('Skill is not enabled');
    return { name, hash: info.hash, content: await readSkill(profileDir, config, name) };
  } }));
  return index;
}

export async function setSkillEnabled(profileDir: string, name: string, enabled: boolean, expectedRevision: string): Promise<string> {
  if (!safeName.test(name)) throw new Error('Invalid skill name');
  const loaded = await loadConfig(profileDir);
  if (loaded.revision !== expectedRevision) throw new Error('Configuration revision conflict');
  const available = await listSkills(profileDir, loaded.config);
  if (!available.some(item => item.name === name)) throw new Error('Skill not found');
  const selected = new Set(loaded.config.skills.enabled);
  if (enabled) selected.add(name); else selected.delete(name);
  const doc = YAML.parseDocument(loaded.text);
  doc.setIn(['skills', 'enabled'], [...selected]);
  return saveConfig(profileDir, String(doc), expectedRevision);
}
