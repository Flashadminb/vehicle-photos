import { createContext, useContext } from 'react';
import type { Role } from '../../shared/types';

export interface Me {
  user: { id: string; username: string; displayName: string; role: Role; mustChangePassword: boolean };
  permissions: string[];
  manageableRoles: Role[];
  demo: boolean;
  settings: { defaultLanguage: string; exportMaxSets: number; unknownPlateLabel: string };
  today: string;
  /** UI hint only. Every action is authorised again on the server. */
  can: (perm: string) => boolean;
}

export const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('MeContext missing');
  return me;
}
