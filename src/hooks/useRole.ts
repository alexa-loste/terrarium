import { useState } from 'react';

// v2.2 — two access levels for the hosted build.
//
//   admin  (alexa)  — sees everything AND controls the world: freeze/unfreeze + speed, and her
//                     client is the only one that heartbeats the world (keeps it alive).
//   viewer (a guest like T) — sees everything, but NO controls. Their client never heartbeats,
//                     so the existing idle-stop cron freezes the world ~5 min after the last
//                     admin is gone. A viewer landing on a stopped world just observes it paused;
//                     only an admin can bring it back to life.
//
// The role is chosen by which password was entered (see PasswordGate) and stored in localStorage.

export type Role = 'admin' | 'viewer';

const ROLE_KEY = 'terrarium-role';

export function getRole(): Role {
  // Back-compat: sessions unlocked before roles existed (admin password, no role stored) are
  // treated as admin so the owner isn't silently downgraded.
  return localStorage.getItem(ROLE_KEY) === 'viewer' ? 'viewer' : 'admin';
}

export function setRole(role: Role) {
  localStorage.setItem(ROLE_KEY, role);
}

export function useRole(): Role {
  // Role is fixed for the session (set at login), so a one-shot read is enough.
  const [role] = useState(getRole);
  return role;
}

export function useIsAdmin(): boolean {
  return useRole() === 'admin';
}
