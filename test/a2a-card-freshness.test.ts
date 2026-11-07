import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { ArdentRuntime } from '../src/runtime.js';
import { createA2ASurface } from '../src/a2a-server.js';

describe('authenticated team-card freshness', () => {
  it('refreshes five-minute discovery on each request while retaining identity and source policy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ardent-team-card-'));
    await initTestProfile(dir, { profile: 'coordinator' });
    await writeFile(join(dir, 'peers.yaml'), 'schema_version: 1\npeers:\n  - id: assistant\n    url: http://127.0.0.1:9901\n    token_env: PEER_TOKEN\n');
    const config = (await loadConfig(dir)).config;
    config.a2a.public_url = 'http://127.0.0.1:9900';
    config.a2a.hermes_compat = true;
    const env = { PEER_TOKEN: 'assistant-card-fixture-token' };
    const runtime = new ArdentRuntime(dir, config, env);
    const surface = await createA2ASurface(runtime, config, env);
    const server = surface.app.listen(0, '127.0.0.1');
    const clock = vi.spyOn(Date, 'now');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No card fixture address');
      const url = `http://127.0.0.1:${address.port}/.well-known/hermes-team-card.json`;
      const headers = { Authorization: `Bearer ${env.PEER_TOKEN}` };
      const firstNow = Date.now();
      clock.mockReturnValue(firstNow);
      const firstResponse = await fetch(url, { headers });
      expect(firstResponse.status).toBe(200);
      expect(firstResponse.headers.get('cache-control')).toBe('private, no-store');
      const first = await firstResponse.json() as { metadata: { hermesTeam: {
        role: string; sourceDigest: string; taskPolicyDigest: string;
        discovery: { observedAt: number; expiresAt: number } } } };
      clock.mockReturnValue(firstNow + 360_000);
      const secondResponse = await fetch(url, { headers });
      expect(secondResponse.status).toBe(200);
      const second = await secondResponse.json() as typeof first;
      expect(first.metadata.hermesTeam.role).toBe('coordinator');
      expect(second.metadata.hermesTeam.role).toBe('coordinator');
      expect(second.metadata.hermesTeam.sourceDigest).toBe(first.metadata.hermesTeam.sourceDigest);
      expect(second.metadata.hermesTeam.taskPolicyDigest).toBe(first.metadata.hermesTeam.taskPolicyDigest);
      expect(second.metadata.hermesTeam.discovery.observedAt).toBe(first.metadata.hermesTeam.discovery.observedAt + 360);
      expect(second.metadata.hermesTeam.discovery.expiresAt).toBe(second.metadata.hermesTeam.discovery.observedAt + 300);
      expect((await fetch(url)).status).toBe(401);
      // Without the compatibility flag the Hermes discovery route is not served.
      const plain = await createA2ASurface(runtime, { ...config, a2a: { ...config.a2a, hermes_compat: false } }, env);
      const plainServer = plain.app.listen(0, '127.0.0.1');
      try {
        await new Promise<void>(resolve => plainServer.once('listening', resolve));
        const plainAddress = plainServer.address();
        if (!plainAddress || typeof plainAddress === 'string') throw new Error('No card fixture address');
        expect((await fetch(`http://127.0.0.1:${plainAddress.port}/.well-known/hermes-team-card.json`, { headers })).status).toBe(404);
      } finally {
        await new Promise<void>(resolve => plainServer.close(() => resolve()));
        plain.grpcServer.forceShutdown();
      }
    } finally {
      clock.mockRestore();
      await new Promise<void>(resolve => server.close(() => resolve()));
      surface.grpcServer.forceShutdown();
      runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
