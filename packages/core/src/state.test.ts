import { describe, expect, it } from 'vitest';
import {
  decideDeploy,
  dueExpiry,
  dueUnpin,
  lapseCleanup,
  nextContract,
  onDeploySuccess,
  onDestructiveApproved,
  onRollbackSuccess,
  planRollback,
  unpinKeep,
  windowLeftMs,
} from './state.ts';
import type { ReleaseFacts, ReleasePatch, ReleaseState } from './state.ts';

function mk(id: string, state: ReleaseState, extra: Partial<ReleaseFacts> = {}): ReleaseFacts {
  return {
    id,
    commitSha: `sha-${id}`,
    state,
    deployedAt: 0,
    supersededAt: null,
    activationSeq: null,
    blockedAt: null,
    imagePurgedAt: null,
    imageUnpinnedAt: null,
    contractedAt: null,
    cleanupState: 'none',
    hasCleanupCmd: false,
    ...extra,
  };
}

function apply(rs: ReleaseFacts[], patches: ReleasePatch[]): Map<string, ReleaseFacts> {
  const out = new Map(rs.map((r) => [r.id, { ...r }]));
  for (const { id, patch } of patches) {
    const r = out.get(id);
    if (!r) throw new Error(`patch for unknown release ${id}`);
    out.set(id, { ...r, ...patch });
  }
  return out;
}

const sorted = (xs: string[]): string[] => [...xs].sort();

describe('decideDeploy', () => {
  const rs = [
    mk('A', 'active'),
    mk('V', 'available'),
    mk('F', 'failed'),
    mk('B', 'blocked'),
    mk('E', 'expired'),
  ];

  it('returns new for an unknown commit', () => {
    expect(decideDeploy(rs, 'sha-unknown')).toEqual({ kind: 'new' });
  });

  it('returns already_active for the active commit', () => {
    expect(decideDeploy(rs, 'sha-A')).toEqual({ kind: 'already_active', releaseId: 'A' });
  });

  it('returns reactivate for an available commit', () => {
    expect(decideDeploy(rs, 'sha-V')).toEqual({ kind: 'reactivate', releaseId: 'V' });
  });

  it('returns redeploy for a failed commit', () => {
    expect(decideDeploy(rs, 'sha-F')).toEqual({ kind: 'redeploy', releaseId: 'F' });
  });

  it('rejects a blocked commit with COMMIT_BLOCKED', () => {
    expect(decideDeploy(rs, 'sha-B')).toEqual({ kind: 'reject', code: 'COMMIT_BLOCKED', releaseId: 'B' });
  });

  it('rejects an expired commit with COMMIT_EXPIRED', () => {
    expect(decideDeploy(rs, 'sha-E')).toEqual({ kind: 'reject', code: 'COMMIT_EXPIRED', releaseId: 'E' });
  });
});

describe('onDeploySuccess', () => {
  it('activates the target with seq max+1 and supersedes the previous active', () => {
    const rs = [
      mk('R1', 'available', { activationSeq: 1, supersededAt: 100 }),
      mk('R2', 'active', { activationSeq: 2 }),
      mk('R3', 'failed'),
    ];
    const after = apply(rs, onDeploySuccess(rs, 'R3', 5000));

    expect(after.get('R3')).toMatchObject({ state: 'active', activationSeq: 3, supersededAt: null });
    expect(after.get('R2')).toMatchObject({ state: 'available', supersededAt: 5000, activationSeq: 2 });
    expect(after.get('R1')).toEqual(rs[0]);
  });
});

describe('planRollback', () => {
  const rs = [
    mk('R1', 'available', { activationSeq: 1 }),
    mk('R2', 'available', { activationSeq: 2 }),
    mk('R3', 'available', { activationSeq: 3 }),
    mk('R4', 'available', { activationSeq: 4 }),
    mk('R5', 'active', { activationSeq: 5 }),
    mk('X', 'expired', { activationSeq: 0 }),
  ];

  it('blocks the active release and every available release activated after the target', () => {
    const plan = planRollback(rs, 'R2');
    expect('block' in plan).toBe(true);
    if (!('block' in plan)) return;
    expect(sorted(plan.block)).toEqual(['R3', 'R4', 'R5']);
  });

  it('refuses a target that is not available', () => {
    expect(planRollback(rs, 'X')).toEqual({ error: 'TARGET_NOT_AVAILABLE' });
  });
});

describe('onRollbackSuccess', () => {
  it('blocks the newer releases, marks cleanup pending only with a cleanup command, and activates the target', () => {
    const rs = [
      mk('R1', 'available', { activationSeq: 1, supersededAt: 200 }),
      mk('R2', 'available', { activationSeq: 2, supersededAt: 300, hasCleanupCmd: true }),
      mk('R3', 'active', { activationSeq: 3, hasCleanupCmd: false }),
    ];
    const after = apply(rs, onRollbackSuccess(rs, 'R1', 9000));

    expect(after.get('R2')).toMatchObject({ state: 'blocked', blockedAt: 9000, cleanupState: 'pending' });
    expect(after.get('R3')).toMatchObject({ state: 'blocked', blockedAt: 9000, cleanupState: 'none' });
    expect(after.get('R1')).toMatchObject({ state: 'active', activationSeq: 4, supersededAt: null });
  });
});

describe('dueExpiry', () => {
  const retentionMs = 500;

  it('expires and purges an available release exactly at retentionMs', () => {
    const rs = [mk('R1', 'available', { supersededAt: 1000 }), mk('R2', 'active')];
    const due = dueExpiry(rs, retentionMs, 1500);
    expect(due.expire).toEqual(['R1']);
    expect(due.purge).toEqual(['R1']);
  });

  it('does not expire an available release at retentionMs-1', () => {
    const rs = [mk('R1', 'available', { supersededAt: 1000 }), mk('R2', 'active')];
    expect(dueExpiry(rs, retentionMs, 1499)).toEqual({ expire: [], purge: [] });
  });

  it('purges an expired release whose image is still present, but not one already purged', () => {
    const rs = [mk('E1', 'expired'), mk('E2', 'expired', { imagePurgedAt: 50 }), mk('R2', 'active')];
    expect(dueExpiry(rs, retentionMs, 1500)).toEqual({ expire: [], purge: ['E1'] });
  });

  it('purges a blocked release older than the window without expiring it', () => {
    const rs = [mk('B1', 'blocked', { blockedAt: 1000 }), mk('R2', 'active')];
    const due = dueExpiry(rs, retentionMs, 1500);
    expect(due.purge).toEqual(['B1']);
    expect(due.expire).toEqual([]);
  });

  it('does not purge a blocked release inside the window', () => {
    const rs = [mk('B1', 'blocked', { blockedAt: 1000 }), mk('R2', 'active')];
    expect(dueExpiry(rs, retentionMs, 1499).purge).toEqual([]);
  });
});

describe('nextContract', () => {
  it('returns null while an older available release exists', () => {
    const rs = [
      mk('R1', 'available', { deployedAt: 1, contractedAt: 10 }),
      mk('R2', 'active', { deployedAt: 2 }),
    ];
    expect(nextContract(rs)).toBeNull();
  });

  it('returns the release once every older one is expired', () => {
    const rs = [
      mk('R1', 'expired', { deployedAt: 1, contractedAt: 10 }),
      mk('R2', 'expired', { deployedAt: 2, contractedAt: 20 }),
      mk('R3', 'active', { deployedAt: 3 }),
    ];
    expect(nextContract(rs)).toBe('R3');
  });

  it('returns null while an older blocked release has pending cleanup', () => {
    const rs = [
      mk('R1', 'blocked', { deployedAt: 1, cleanupState: 'pending', hasCleanupCmd: true }),
      mk('R2', 'active', { deployedAt: 2 }),
    ];
    expect(nextContract(rs)).toBeNull();
  });

  it('skips blocked and failed releases as candidates', () => {
    const rs = [
      mk('R1', 'failed', { deployedAt: 1 }),
      mk('R2', 'blocked', { deployedAt: 2, cleanupState: 'applied' }),
      mk('R3', 'active', { deployedAt: 3 }),
    ];
    expect(nextContract(rs)).toBe('R3');
  });
});

describe('onDestructiveApproved', () => {
  it('returns every available release', () => {
    const rs = [
      mk('R1', 'available', { deployedAt: 1 }),
      mk('R2', 'blocked', { deployedAt: 2 }),
      mk('R3', 'available', { deployedAt: 3 }),
      mk('R4', 'active', { deployedAt: 4 }),
      mk('R5', 'available', { deployedAt: 5 }),
    ];
    expect(sorted(onDestructiveApproved(rs))).toEqual(['R1', 'R3', 'R5']);
  });
});

describe('lapseCleanup', () => {
  it('returns blocked releases with pending cleanup whose image is purged', () => {
    const rs = [
      mk('B1', 'blocked', { cleanupState: 'pending', imagePurgedAt: 100 }),
      mk('B2', 'blocked', { cleanupState: 'pending' }),
      mk('B3', 'blocked', { cleanupState: 'applied', imagePurgedAt: 100 }),
      mk('R4', 'active'),
    ];
    expect(lapseCleanup(rs)).toEqual(['B1']);
  });
});

describe('windowLeftMs', () => {
  const retentionMs = 500;

  it('returns the exact remaining ms for an available release inside the window', () => {
    expect(windowLeftMs(mk('R1', 'available', { supersededAt: 1000 }), retentionMs, 1200)).toBe(300);
  });

  it('returns 0 for an available release past the window', () => {
    expect(windowLeftMs(mk('R1', 'available', { supersededAt: 1000 }), retentionMs, 1700)).toBe(0);
  });

  it('returns null for active, blocked and expired releases', () => {
    expect(windowLeftMs(mk('A', 'active'), retentionMs, 1200)).toBeNull();
    expect(windowLeftMs(mk('B', 'blocked', { blockedAt: 1000 }), retentionMs, 1200)).toBeNull();
    expect(windowLeftMs(mk('E', 'expired', { supersededAt: 1000 }), retentionMs, 1200)).toBeNull();
  });
});

type U = ReleaseFacts & { stored: boolean; images: Record<string, { ref: string }> };
const u = (id: string, state: ReleaseState, extra: Partial<U> = {}): U =>
  ({ ...mk(id, state), stored: true, images: { web: { ref: `app:${id}` } }, ...extra });

describe('dueUnpin', () => {
  it('keeps the active and the most recently superseded release, oldest first', () => {
    const rs = [
      u('R4', 'active'),
      u('R3', 'available', { supersededAt: 300 }),
      u('R2', 'available', { supersededAt: 200 }),
      u('R1', 'available', { supersededAt: 100 }),
    ];
    expect(dueUnpin(rs)).toEqual(['R1', 'R2']);
  });

  it('breaks a supersededAt tie by the larger deployedAt', () => {
    const rs = [
      u('A', 'active'),
      u('P', 'available', { supersededAt: 100, deployedAt: 20 }),
      u('Q', 'available', { supersededAt: 100, deployedAt: 10 }),
    ];
    expect(dueUnpin(rs)).toEqual(['Q']);
  });

  it('skips unstored, purged, already unpinned, failed, expired and pending-cleanup blocked releases', () => {
    const rs = [
      u('A', 'active'),
      u('PREV', 'available', { supersededAt: 999 }),
      u('S', 'available', { supersededAt: 1, stored: false }),
      u('PU', 'available', { supersededAt: 2, imagePurgedAt: 5 }),
      u('UN', 'available', { supersededAt: 3, imageUnpinnedAt: 5 }),
      u('F', 'failed'),
      u('E', 'expired', { supersededAt: 4 }),
      u('BP', 'blocked', { blockedAt: 1, cleanupState: 'pending' }),
    ];
    expect(dueUnpin(rs)).toEqual([]);
  });

  it.each(['none', 'applied', 'dismissed', 'lapsed'] as const)('unpins a stored blocked release with cleanupState %s', (cs) => {
    const rs = [u('A', 'active'), u('PREV', 'available', { supersededAt: 999 }), u('B', 'blocked', { blockedAt: 1, cleanupState: cs })];
    expect(dueUnpin(rs)).toEqual(['B']);
  });
});

describe('unpinKeep', () => {
  it('keeps a ref shared with a retained release and drops one shared only with another unpinned release', () => {
    const rs = [
      u('A', 'active', { images: { web: { ref: 'app:shared' } } }),
      u('P', 'available', { supersededAt: 300, images: { web: { ref: 'app:p' } } }),
      u('Y', 'available', { supersededAt: 200, images: { web: { ref: 'app:x' } } }),
      u('X', 'available', { supersededAt: 100, images: { web: { ref: 'app:shared' }, worker: { ref: 'app:x' } } }),
    ];
    const due = dueUnpin(rs);
    expect(due).toEqual(['X', 'Y']);
    expect(unpinKeep(rs, due, 'X')).toEqual(['app:shared']);
    expect(unpinKeep(rs, due, 'Y')).toEqual([]);
  });

  it('keeps a ref shared with the previous release but not one held only by a purged or unpinned release', () => {
    const rs = [
      u('A', 'active', { images: { web: { ref: 'app:a' } } }),
      u('P', 'available', { supersededAt: 300, images: { web: { ref: 'app:prev' } } }),
      u('G', 'expired', { supersededAt: 50, imagePurgedAt: 60, images: { web: { ref: 'app:gone' } } }),
      u('N', 'available', { supersededAt: 150, imageUnpinnedAt: 160, images: { web: { ref: 'app:gone' } } }),
      u('X', 'available', { supersededAt: 100, images: { web: { ref: 'app:prev' }, worker: { ref: 'app:gone' } } }),
    ];
    const due = dueUnpin(rs);
    expect(due).toEqual(['X']);
    expect(unpinKeep(rs, due, 'X')).toEqual(['app:prev']);
  });

  it('always keeps the release own digest-qualified refs', () => {
    const rs = [
      u('A', 'active', { images: { web: { ref: 'reg/app:a' } } }),
      u('P', 'available', { supersededAt: 300, images: { web: { ref: 'reg/app:p' } } }),
      u('X', 'available', { supersededAt: 100, images: { web: { ref: 'reg/app@sha256:abc' }, worker: { ref: 'reg/app:x' } } }),
    ];
    const due = dueUnpin(rs);
    expect(due).toEqual(['X']);
    expect(unpinKeep(rs, due, 'X')).toEqual(['reg/app@sha256:abc']);
  });

  it('treats an untagged ref and its :latest spelling as the same tag, returning the due release spelling', () => {
    const rs = [
      u('A', 'active', { images: { web: { ref: 'reg/app' } } }),
      u('P', 'available', { supersededAt: 300, images: { web: { ref: 'reg/app:p' } } }),
      u('X', 'available', { supersededAt: 100, images: { web: { ref: 'reg/app:latest' } } }),
    ];
    expect(unpinKeep(rs, dueUnpin(rs), 'X')).toEqual(['reg/app:latest']);
  });

  it('treats a :latest ref and its untagged spelling as the same tag, returning the due release spelling', () => {
    const rs = [
      u('A', 'active', { images: { web: { ref: 'reg/app:latest' } } }),
      u('P', 'available', { supersededAt: 300, images: { web: { ref: 'reg/app:p' } } }),
      u('X', 'available', { supersededAt: 100, images: { web: { ref: 'reg/app' } } }),
    ];
    expect(unpinKeep(rs, dueUnpin(rs), 'X')).toEqual(['reg/app']);
  });
});

describe('activation resets imageUnpinnedAt', () => {
  it('on deploy success (reactivation)', () => {
    const rs = [mk('R1', 'available', { activationSeq: 1, supersededAt: 100, imageUnpinnedAt: 150 }), mk('R2', 'active', { activationSeq: 2 })];
    const target = onDeploySuccess(rs, 'R1', 5000).find((p) => p.id === 'R1')!;
    expect(target.patch).toMatchObject({ state: 'active', imageUnpinnedAt: null });
  });

  it('on rollback success', () => {
    const rs = [mk('R1', 'available', { activationSeq: 1, supersededAt: 100, imageUnpinnedAt: 150 }), mk('R2', 'active', { activationSeq: 2 })];
    const target = onRollbackSuccess(rs, 'R1', 5000).find((p) => p.id === 'R1')!;
    expect(target.patch).toMatchObject({ state: 'active', imageUnpinnedAt: null });
  });
});
