import type { Role } from '../../shared/types';

/**
 * Server-side permission matrix. Every protected admin route checks one of these.
 * (Hiding a button in the UI is never relied on for security.)
 */
export const PERMISSIONS = {
  'sets.view': ['super_admin', 'admin', 'reviewer'],
  'sets.viewHidden': ['super_admin', 'admin'],
  'sets.viewRemoved': ['super_admin'],
  'sets.hide': ['super_admin', 'admin'],
  'sets.remove': ['super_admin', 'admin'],
  'sets.restore': ['super_admin'],
  'sets.editPlate': ['super_admin', 'admin'],
  'sets.export': ['super_admin', 'admin', 'reviewer'],
  'config.edit': ['super_admin', 'admin'],
  'users.manage': ['super_admin', 'admin'],
  'drive.manage': ['super_admin'],
  /** Move set photos to the Drive trash (recoverable). Never a permanent delete. */
  'drive.trash': ['super_admin'],
  'storage.view': ['super_admin', 'admin'],
  'storage.manage': ['super_admin'],
  'audit.view': ['super_admin', 'admin'],
  'demo.seed': ['super_admin', 'admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, perm: Permission): boolean {
  return (PERMISSIONS[perm] as readonly Role[]).includes(role);
}

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}

/** Which roles a given admin may assign / manage. Admins cannot manage admins or super admins. */
export function manageableRoles(role: Role): Role[] {
  if (role === 'super_admin') return ['super_admin', 'admin', 'reviewer', 'operator'];
  if (role === 'admin') return ['reviewer', 'operator'];
  return [];
}
