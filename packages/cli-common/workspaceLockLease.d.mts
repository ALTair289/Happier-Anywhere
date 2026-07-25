export type WorkspaceLockLease = Readonly<{
  path: string;
  token: string;
}>;

export type WorkspaceLockOwner = Readonly<{
  token?: unknown;
}> | null | undefined;

export function createWorkspaceLockLeaseValue(params: {
  lockPath: string;
  ownerToken: string;
}): string;

export function parseWorkspaceLockLeaseValue(value: unknown): WorkspaceLockLease | null;

export function workspaceLockLeaseMatchesOwner(params: {
  lockPath: string;
  leaseValue: unknown;
  owner: WorkspaceLockOwner;
}): boolean;
