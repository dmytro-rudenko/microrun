export type ReleaseState = 'active' | 'available' | 'blocked' | 'expired' | 'failed';
export type CleanupState = 'none' | 'pending' | 'applied' | 'dismissed' | 'lapsed';

export interface ReleaseFacts {
  id: string;
  commitSha: string;
  state: ReleaseState;
  deployedAt: number;
  supersededAt: number | null;
  activationSeq: number | null;
  blockedAt: number | null;
  imagePurgedAt: number | null;
  imageUnpinnedAt: number | null;
  contractedAt: number | null;
  cleanupState: CleanupState;
  hasCleanupCmd: boolean;
}

export type ReleasePatch = { id: string; patch: Partial<ReleaseFacts> };

export type DeployDecision =
  | { kind: 'new' }
  | { kind: 'already_active'; releaseId: string }
  | { kind: 'reactivate'; releaseId: string }
  | { kind: 'redeploy'; releaseId: string }
  | { kind: 'reject'; code: 'COMMIT_BLOCKED' | 'COMMIT_EXPIRED'; releaseId: string };

export function decideDeploy(rs: ReleaseFacts[], commitSha: string): DeployDecision {
  const r = rs.find((x) => x.commitSha === commitSha);
  if (!r) return { kind: 'new' };
  switch (r.state) {
    case 'active':
      return { kind: 'already_active', releaseId: r.id };
    case 'available':
      return { kind: 'reactivate', releaseId: r.id };
    case 'failed':
      return { kind: 'redeploy', releaseId: r.id };
    case 'blocked':
      return { kind: 'reject', code: 'COMMIT_BLOCKED', releaseId: r.id };
    case 'expired':
      return { kind: 'reject', code: 'COMMIT_EXPIRED', releaseId: r.id };
  }
}

function nextSeq(rs: ReleaseFacts[]): number {
  return Math.max(0, ...rs.map((r) => r.activationSeq ?? 0)) + 1;
}

function activate(rs: ReleaseFacts[], releaseId: string): ReleasePatch {
  return { id: releaseId, patch: { state: 'active', activationSeq: nextSeq(rs), supersededAt: null, imageUnpinnedAt: null } };
}

export function onDeploySuccess(rs: ReleaseFacts[], releaseId: string, now: number): ReleasePatch[] {
  const superseded: ReleasePatch[] = rs
    .filter((r) => r.state === 'active' && r.id !== releaseId)
    .map((r) => ({ id: r.id, patch: { state: 'available', supersededAt: now } }));
  return [...superseded, activate(rs, releaseId)];
}

export function planRollback(
  rs: ReleaseFacts[],
  targetId: string,
): { block: string[] } | { error: 'TARGET_NOT_AVAILABLE' } {
  const target = rs.find((r) => r.id === targetId);
  if (!target || target.state !== 'available') return { error: 'TARGET_NOT_AVAILABLE' };
  const seq = target.activationSeq ?? 0;
  const block = rs
    .filter((r) => r.state === 'active' || (r.state === 'available' && (r.activationSeq ?? 0) > seq))
    .map((r) => r.id);
  return { block };
}

export function onRollbackSuccess(rs: ReleaseFacts[], targetId: string, now: number): ReleasePatch[] {
  const plan = planRollback(rs, targetId);
  if ('error' in plan) return [];
  const blocked: ReleasePatch[] = rs
    .filter((r) => plan.block.includes(r.id))
    .map((r) => ({
      id: r.id,
      patch: r.hasCleanupCmd
        ? { state: 'blocked', blockedAt: now, cleanupState: 'pending' }
        : { state: 'blocked', blockedAt: now },
    }));
  return [...blocked, activate(rs, targetId)];
}

export function dueExpiry(
  rs: ReleaseFacts[],
  retentionMs: number,
  now: number,
): { expire: string[]; purge: string[] } {
  const expire = rs
    .filter((r) => r.state === 'available' && r.supersededAt !== null && now - r.supersededAt >= retentionMs)
    .map((r) => r.id);
  const purge = rs
    .filter(
      (r) =>
        r.imagePurgedAt === null &&
        (r.state === 'expired' ||
          expire.includes(r.id) ||
          (r.state === 'blocked' && r.blockedAt !== null && now - r.blockedAt >= retentionMs)),
    )
    .map((r) => r.id);
  return { expire, purge };
}

export type UnpinFacts = ReleaseFacts & { stored: boolean; images: Record<string, { ref: string }> };

const newerSuperseded = (a: ReleaseFacts, b: ReleaseFacts) =>
  (b.supersededAt ?? 0) - (a.supersededAt ?? 0) || b.deployedAt - a.deployedAt;

export function dueUnpin(rs: UnpinFacts[]): string[] {
  const previous = rs.filter((r) => r.state === 'available').sort(newerSuperseded)[0]?.id;
  return rs
    .filter(
      (r) =>
        r.id !== previous &&
        r.stored &&
        r.imagePurgedAt === null &&
        r.imageUnpinnedAt === null &&
        (r.state === 'available' || (r.state === 'blocked' && r.cleanupState !== 'pending')),
    )
    .sort((a, b) => -newerSuperseded(a, b))
    .map((r) => r.id);
}

const normRef = (ref: string) => (ref.includes('@') || ref.slice(ref.lastIndexOf('/') + 1).includes(':') ? ref : `${ref}:latest`);

export function unpinKeep(rs: UnpinFacts[], due: string[], id: string): string[] {
  const own = new Set(Object.values(rs.find((r) => r.id === id)?.images ?? {}).map((i) => i.ref));
  const held = new Set(
    rs
      .filter((r) => !due.includes(r.id) && r.imagePurgedAt === null && r.imageUnpinnedAt === null)
      .flatMap((r) => Object.values(r.images).map((i) => normRef(i.ref))),
  );
  return [...own].filter((ref) => ref.includes('@') || held.has(normRef(ref))).sort();
}

export function nextContract(rs: ReleaseFacts[]): string | null {
  const candidates = rs
    .filter((r) => (r.state === 'active' || r.state === 'available' || r.state === 'expired') && r.contractedAt === null)
    .sort((a, b) => a.deployedAt - b.deployedAt);
  const found = candidates.find((c) =>
    rs
      .filter((r) => r.deployedAt < c.deployedAt)
      .every(
        (r) => (r.state === 'expired' || r.state === 'blocked' || r.state === 'failed') && r.cleanupState !== 'pending',
      ),
  );
  return found?.id ?? null;
}

export function onDestructiveApproved(rs: ReleaseFacts[]): string[] {
  return rs.filter((r) => r.state === 'available').map((r) => r.id);
}

export function windowLeftMs(r: ReleaseFacts, retentionMs: number, now: number): number | null {
  if (r.state !== 'available' || r.supersededAt === null) return null;
  return Math.max(0, r.supersededAt + retentionMs - now);
}

export function lapseCleanup(rs: ReleaseFacts[]): string[] {
  return rs
    .filter((r) => r.state === 'blocked' && r.cleanupState === 'pending' && r.imagePurgedAt !== null)
    .map((r) => r.id);
}
