import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { openDb } from './db.ts';
import { BusyError, Repo } from './repo.ts';

let db: Knex;
let repo: Repo;

beforeEach(async () => {
  db = await openDb(':memory:');
  repo = new Repo(db);
});

afterEach(async () => {
  await db.destroy();
});

async function mkServer(name = 'main') {
  return repo.createServer({ name, agentTokenHash: `hash-${name}`, builtin: false });
}

async function mkEnv(serverId: string, name: string, branch: string) {
  return repo.saveEnv({
    name,
    branch,
    isProduction: false,
    position: 0,
    serverId,
    composeProject: `proj-${name}`,
    composeDir: `/srv/${name}`,
    composeFiles: ['docker-compose.yml'],
    composeEnvFiles: ['/etc/shop/.env'],
    services: [{ name: 'web', strategy: 'rolling', domain: `${name}.example.com`, port: 3000 }],
    migrationService: 'web',
    dbKind: 'postgres',
    dbUrlEnv: 'DATABASE_URL',
    migrationTables: ['knex_migrations'],
    expandCmd: 'npm run migrate',
    contractCmd: null,
    cleanupCmd: null,
    schemaCheck: 'dry_run',
    healthTimeoutS: 120,
    storageKind: 'local',
    storageConfigEnc: Buffer.from([1, 2, 3]),
    retentionS: 86400,
    deployTokenHash: `deploy-${name}`,
  });
}

function newRelease(envId: string, commitSha: string, state: 'active' | 'available') {
  return {
    envId,
    commitSha,
    images: { web: { ref: `app:${commitSha}`, digest: `sha256:${commitSha}` } },
    author: 'alice',
    message: `commit ${commitSha}`,
    deployedAt: 1000,
    schemaSnapshot: { tables: [] },
    schemaDiff: { changes: [] },
    state,
    stored: true,
  };
}

function newOperation(envId: string, status: 'pending' | 'running' = 'pending') {
  return {
    envId,
    kind: 'deploy' as const,
    fromReleaseId: null,
    toReleaseId: null,
    actor: 'admin',
    status,
    startedAt: 1000,
  };
}

describe('Repo', () => {
  it('rejects a second active release for the same env', async () => {
    const s = await mkServer();
    const env = await mkEnv(s.id, 'staging', 'develop');
    await repo.insertRelease(newRelease(env.id, 'aaa', 'active'));
    await repo.insertRelease(newRelease(env.id, 'bbb', 'available'));

    await expect(repo.insertRelease(newRelease(env.id, 'ccc', 'active'))).rejects.toThrow();

    const rs = await repo.listReleases(env.id);
    expect(rs.map((r) => r.commitSha).sort()).toEqual(['aaa', 'bbb']);
  });

  it('throws BusyError for a second pending operation on the same env', async () => {
    const s = await mkServer();
    const env = await mkEnv(s.id, 'staging', 'develop');
    const other = await mkEnv(s.id, 'prod', 'main');
    await repo.createOperation(newOperation(env.id));

    await expect(repo.createOperation(newOperation(env.id))).rejects.toBeInstanceOf(BusyError);
    await expect(repo.createOperation(newOperation(env.id, 'running'))).rejects.toBeInstanceOf(BusyError);
    await expect(repo.createOperation(newOperation(other.id))).resolves.toMatchObject({ envId: other.id });
  });

  it('stores a succeeded approve operation next to a running one', async () => {
    const s = await mkServer();
    const env = await mkEnv(s.id, 'staging', 'develop');
    await repo.createOperation(newOperation(env.id, 'running'));
    const op = await repo.createOperation({ ...newOperation(env.id), kind: 'approve', status: 'succeeded', params: { commit: 'abc1234' } });
    expect(await repo.getOperation(op.id)).toMatchObject({ kind: 'approve', status: 'succeeded', params: { commit: 'abc1234' } });
  });

  it('rejects an env with a duplicate branch', async () => {
    const s = await mkServer();
    await mkEnv(s.id, 'staging', 'develop');

    await expect(mkEnv(s.id, 'staging-2', 'develop')).rejects.toThrow();
    expect(await repo.listEnvs()).toHaveLength(1);
  });

  it('rejects a duplicate db_marker_id', async () => {
    const s = await mkServer();
    const a = await mkEnv(s.id, 'staging', 'develop');
    const b = await mkEnv(s.id, 'prod', 'main');
    await repo.setEnvMarker(a.id, 'marker-1');

    await expect(repo.setEnvMarker(b.id, 'marker-1')).rejects.toThrow();
    expect((await repo.getEnv(a.id))?.dbMarkerId).toBe('marker-1');
    expect((await repo.getEnv(b.id))?.dbMarkerId).toBeNull();
  });

  it('round-trips JSON columns', async () => {
    const s = await mkServer();
    const env = await mkEnv(s.id, 'staging', 'develop');

    const e = await repo.getEnv(env.id);
    expect(e?.composeFiles).toEqual(['docker-compose.yml']);
    expect(e?.composeEnvFiles).toEqual(['/etc/shop/.env']);
    expect(e?.services).toEqual([{ name: 'web', strategy: 'rolling', domain: 'staging.example.com', port: 3000 }]);
    expect(e?.migrationTables).toEqual(['knex_migrations']);
    expect(Buffer.from(e!.storageConfigEnc)).toEqual(Buffer.from([1, 2, 3]));

    const rel = await repo.insertRelease(newRelease(env.id, 'aaa', 'active'));
    await repo.patchReleases([{ id: rel.id, patch: { cleanupPreview: { drop: ['old_col'] } } }]);
    const r = await repo.getRelease(rel.id);
    expect(r?.images).toEqual({ web: { ref: 'app:aaa', digest: 'sha256:aaa' } });
    expect(r?.schemaSnapshot).toEqual({ tables: [] });
    expect(r?.schemaDiff).toEqual({ changes: [] });
    expect(r?.cleanupPreview).toEqual({ drop: ['old_col'] });

    const op = await repo.createOperation(newOperation(env.id));
    await repo.updateOperation(op.id, { params: { sha: 'aaa', n: 2 } });
    expect((await repo.getOperation(op.id))?.params).toEqual({ sha: 'aaa', n: 2 });

    await repo.putApproval({ envId: env.id, commitSha: 'bbb', diff: { destructive: ['drop users.age'] }, approvedAt: 2000 });
    expect((await repo.getApproval(env.id, 'bbb'))?.diff).toEqual({ destructive: ['drop users.age'] });
  });

  it('markStepDone accumulates steps_done', async () => {
    const s = await mkServer();
    const env = await mkEnv(s.id, 'staging', 'develop');
    const op = await repo.createOperation(newOperation(env.id));

    await repo.markStepDone(op.id, 'pull', { digest: 'sha256:aaa' });
    await repo.markStepDone(op.id, 'switch', { ok: true });

    expect((await repo.getOperation(op.id))?.stepsDone).toEqual({
      pull: { digest: 'sha256:aaa' },
      switch: { ok: true },
    });
  });

  it('expires a session after the ttl', async () => {
    await repo.createSession('sess-1', 1000, 500);

    expect(await repo.getSession('sess-1', 1499)).toBe(true);
    expect(await repo.getSession('sess-1', 2000)).toBe(false);
    expect(await repo.getSession('missing', 1000)).toBe(false);
  });

  it('tx rolls back on throw', async () => {
    await expect(
      repo.tx(async (r) => {
        await r.createServer({ name: 'tmp', agentTokenHash: 'h', builtin: false });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await repo.listServers()).toEqual([]);
  });

  describe('deleteServer', () => {
    it('refuses the builtin server', async () => {
      const s = await repo.createServer({ name: 'local', agentTokenHash: 'h', builtin: true });

      expect(await repo.deleteServer(s.id)).toBe('builtin');
      expect(await repo.getServer(s.id)).not.toBeNull();
    });

    it('refuses a server that still has environments', async () => {
      const s = await mkServer();
      await mkEnv(s.id, 'staging', 'develop');

      expect(await repo.deleteServer(s.id)).toBe('has-envs');
      expect(await repo.getServer(s.id)).not.toBeNull();
    });

    it('deletes a bare server, then reports it missing', async () => {
      const s = await mkServer();

      expect(await repo.deleteServer(s.id)).toBe('deleted');
      expect(await repo.getServer(s.id)).toBeNull();
      expect(await repo.deleteServer(s.id)).toBe('missing');
    });
  });

  describe('deleteEnv', () => {
    it('refuses an environment with a running operation', async () => {
      const s = await mkServer();
      const env = await mkEnv(s.id, 'staging', 'develop');
      await repo.createOperation(newOperation(env.id, 'running'));

      expect(await repo.deleteEnv(env.id)).toBe('busy');
      expect(await repo.getEnv(env.id)).not.toBeNull();
    });

    it('refuses an environment with a pending operation', async () => {
      const s = await mkServer();
      const env = await mkEnv(s.id, 'staging', 'develop');
      await repo.createOperation(newOperation(env.id, 'pending'));

      expect(await repo.deleteEnv(env.id)).toBe('busy');
      expect(await repo.getEnv(env.id)).not.toBeNull();
    });

    it('deletes the environment with its releases, operations and approvals, then reports it missing', async () => {
      const s = await mkServer();
      const env = await mkEnv(s.id, 'staging', 'develop');
      const op = await repo.createOperation({ ...newOperation(env.id), status: 'succeeded' });
      const rel = await repo.insertRelease(newRelease(env.id, 'aaa', 'available'));
      await db('releases').where({ id: rel.id }).update({ blocked_by_op: op.id });
      await repo.putApproval({ envId: env.id, commitSha: 'aaa', diff: { destructive: ['drop users.age'] }, approvedAt: 2000 });

      expect(await repo.deleteEnv(env.id)).toBe('deleted');
      expect(await repo.getEnv(env.id)).toBeNull();
      for (const t of ['destructive_approvals', 'releases', 'operations']) {
        expect(await db(t).where({ env_id: env.id })).toEqual([]);
      }
      expect(await repo.deleteEnv(env.id)).toBe('missing');
    });
  });

  it('findEnvByMarker returns the env carrying the marker, otherwise null', async () => {
    const s = await mkServer();
    const env = await mkEnv(s.id, 'staging', 'develop');

    expect(await repo.findEnvByMarker('marker-1')).toBeNull();
    await repo.setEnvMarker(env.id, 'marker-1');
    expect((await repo.findEnvByMarker('marker-1'))?.id).toBe(env.id);
    expect(await repo.findEnvByMarker('marker-2')).toBeNull();
  });

  it('countEnvsOnServer counts the environments on that server', async () => {
    const s = await mkServer();
    const other = await mkServer('other');
    await mkEnv(other.id, 'elsewhere', 'feature');

    expect(await repo.countEnvsOnServer(s.id)).toBe(0);
    await mkEnv(s.id, 'staging', 'develop');
    await mkEnv(s.id, 'prod', 'main');
    expect(await repo.countEnvsOnServer(s.id)).toBe(2);
  });
});

describe('image_unpinned_at', () => {
  it('stores image_unpinned_at, null by default', async () => {
    const server = await mkServer();
    const env = await mkEnv(server.id, 'prod', 'main');
    const r = await repo.insertRelease(newRelease(env.id, 'aaa', 'available'));
    expect((await repo.getRelease(r.id))!.imageUnpinnedAt).toBeNull();
    await repo.patchReleases([{ id: r.id, patch: { imageUnpinnedAt: 42 } }]);
    expect((await repo.getRelease(r.id))!.imageUnpinnedAt).toBe(42);
  });
});
