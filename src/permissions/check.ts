// Permission gate. Single function used everywhere — admin routes, API
// routes, content writes. Memoized per request via a small cache in
// AuthContext (see middleware.ts).
//
// Built-in roles seed admin with `*` capabilities; the check function
// short-circuits when the user's role contains a literal "*" in its
// global capabilities list.

import type { RoleCapabilities } from '../auth/users.js';

export type Action =
  | 'read'
  | 'create'
  | 'update'
  | 'updateOwn'
  | 'delete'
  | 'deleteOwn'
  | 'publish'
  | 'readDrafts'
  | 'readOthersDrafts'
  // global:
  | 'manageUsers'
  | 'manageRoles'
  | 'manageTypes'
  | 'manageSettings'
  | 'manageMenus'
  | 'manageRedirects'
  | 'manageMedia'
  | 'manageForms'
  | 'viewAnalytics'
  | 'viewAuditLog'
  | 'exportData'
  | 'manageJobs';

const GLOBAL_ACTIONS = new Set<Action>([
  'manageUsers',
  'manageRoles',
  'manageTypes',
  'manageSettings',
  'manageMenus',
  'manageRedirects',
  'manageMedia',
  'manageForms',
  'viewAnalytics',
  'viewAuditLog',
  'exportData',
  'manageJobs',
]);

interface CanContext {
  userId: number;
  caps: RoleCapabilities;
}

/**
 * Check whether the user can perform `action` on a content row of `typeSlug`,
 * optionally owned by `ownerId`. For global actions, omit typeSlug.
 *
 * @example
 *   can(ctx, 'publish', 'post')            // capability on type
 *   can(ctx, 'updateOwn', 'post', row.authorId)  // ownership check
 *   can(ctx, 'manageUsers')                // global capability
 */
export function can(
  ctx: CanContext,
  action: Action,
  typeSlug?: string,
  ownerId?: number | null,
): boolean {
  if (GLOBAL_ACTIONS.has(action)) {
    return ctx.caps.global.includes(action) || ctx.caps.global.includes('*');
  }

  if (!typeSlug) return false;

  // Wildcard role (admin) — short-circuit.
  if (ctx.caps.global.includes('*')) return true;

  const typeCaps = ctx.caps.types[typeSlug] ?? ctx.caps.types['*'] ?? [];

  if (typeCaps.includes(action)) return true;

  // Ownership-bounded permissions: `update` implies `updateOwn`.
  if (action === 'updateOwn' || action === 'deleteOwn') {
    if (ownerId === null || ownerId === undefined) return false;
    if (ownerId !== ctx.userId) return false;
    const ownAction = action;
    const baseAction = action === 'updateOwn' ? 'update' : 'delete';
    return typeCaps.includes(ownAction) || typeCaps.includes(baseAction);
  }

  // `update` and `delete` requested but only `*Own` granted → check ownership.
  if (action === 'update' && typeCaps.includes('updateOwn')) {
    return ownerId !== null && ownerId !== undefined && ownerId === ctx.userId;
  }
  if (action === 'delete' && typeCaps.includes('deleteOwn')) {
    return ownerId !== null && ownerId !== undefined && ownerId === ctx.userId;
  }

  return false;
}
