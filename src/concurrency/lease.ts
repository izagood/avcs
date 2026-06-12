// Phase 3: WorkLease — reduce conflicts at the START of work, not after.
//
// Before an agent edits a scope it can request a soft, optimistic lease. The lease
// is advisory (it expires; it is not a hard lock), but requesting an exclusive
// write-lease on a scope that another live exclusive lease already holds returns a
// conflict so the second agent can pick different work instead of duplicating
// effort and forcing a human decision later.

import type { ScopeRef, WorkLease } from "../objects/types.ts";

export interface LeaseConflict {
  scope: ScopeRef;
  heldBy: string; // actor id
  leaseOid: string;
}

/** Is the lease still in force at `nowIso`? */
export function isActive(lease: WorkLease, nowIso: string): boolean {
  if (lease.releasedAt) return false;
  return lease.expiresAt > nowIso;
}

/**
 * Two scopes overlap when one is a prefix of the other under the `kind:path`
 * convention. "file:src/a.ts" overlaps "file:src/a.ts"; a glob-ish "file:src/*"
 * (stored as "file:src/") overlaps anything beneath it. Symbol scopes nest under
 * their file when the file scope is held.
 */
export function scopesOverlap(a: ScopeRef, b: ScopeRef): boolean {
  if (a === b) return true;
  const norm = (s: ScopeRef) => s.replace(/\*+$/, "");
  const [na, nb] = [norm(a), norm(b)];
  if (na.endsWith("/") && b.startsWith(na)) return true;
  if (nb.endsWith("/") && a.startsWith(nb)) return true;
  // A held file scope covers symbol scopes within that file ("symbol:<file>#...").
  const fileOf = (s: ScopeRef) => (s.startsWith("symbol:") ? "file:" + s.slice("symbol:".length).split("#")[0] : null);
  const fa = fileOf(a);
  const fb = fileOf(b);
  if (fa && fa === b) return true;
  if (fb && fb === a) return true;
  return false;
}

/**
 * Check a requested set of write scopes against the currently-active leases.
 * Returns the conflicts (empty ⇒ grantable). `shared` leases never conflict with
 * each other; an `exclusive` request conflicts with any overlapping active lease,
 * and an `exclusive` holder conflicts with any new overlapping request.
 */
export function checkLease(
  request: { writeScopes: ScopeRef[]; mode: "exclusive" | "shared"; actorId: string },
  active: WorkLease[],
): LeaseConflict[] {
  const conflicts: LeaseConflict[] = [];
  for (const held of active) {
    if (held.actor.id === request.actorId) continue; // own leases never block self
    for (const reqScope of request.writeScopes) {
      for (const heldScope of held.writeScopes) {
        if (!scopesOverlap(reqScope, heldScope)) continue;
        const exclusiveInvolved = request.mode === "exclusive" || held.mode === "exclusive";
        if (exclusiveInvolved) {
          conflicts.push({ scope: reqScope, heldBy: held.actor.id, leaseOid: held.oid as string });
        }
      }
    }
  }
  return conflicts;
}
