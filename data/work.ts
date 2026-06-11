// Terrarium v1.9 — WORK CADENCE + OBLIGATION.
//
// Until now "work" was loose: wander toward your workplace during the day, sometimes earn a
// wage, sometimes make a thing. Now work has a SHAPE and STAKES. Two kinds of job:
//
//   - scheduled: you must be at your workplace during set hours (a shift). Wages accrue only
//     while you're actually on shift; skip your shift and you lose the pay, your standing, and
//     you feel the stress.
//   - deliverable: you owe N pieces of real work every M days. Each shipped piece pays; finish a
//     cycle short of quota and you take the money/standing/stress hit.
//
// Consequences (per alexa): money + reputation/standing + stress (which surfaces in their inner
// life and pushes them to catch up). Wired in convex/aiTown/agentOperations.ts (tickVitals
// wage gate, maybeGoToWork, deliverable counting, evaluateWorkDay) + convex/work.ts (state) +
// convex/relationships.ts (standing penalty folds into reputation).

import { wageFor } from './economy';

export type Job =
  | { kind: 'scheduled'; startHour: number; endHour: number }
  | { kind: 'deliverable'; quota: number; perDays: number };

// Who works how. Scheduled people keep hours; deliverable people owe output on a cadence.
export const JOBS: Record<string, Job> = {
  Priya: { kind: 'scheduled', startHour: 9, endHour: 18 }, // lab researcher
  Russ: { kind: 'scheduled', startHour: 8, endHour: 20 }, // ER — long shifts
  Gloria: { kind: 'scheduled', startHour: 9, endHour: 17 }, // city hall
  Yuki: { kind: 'scheduled', startHour: 10, endHour: 18 }, // the Commons
  Naomi: { kind: 'scheduled', startHour: 10, endHour: 18 }, // coworking researcher
  Mara: { kind: 'deliverable', quota: 2, perDays: 2 }, // founder shipping
  Theo: { kind: 'deliverable', quota: 1, perDays: 2 }, // artist
  Desmond: { kind: 'deliverable', quota: 2, perDays: 2 }, // journalist filing
};

const DEFAULT_JOB: Job = { kind: 'deliverable', quota: 1, perDays: 2 };

export function jobFor(character: string): Job {
  return JOBS[character] ?? DEFAULT_JOB;
}

export function isScheduled(character: string): boolean {
  return jobFor(character).kind === 'scheduled';
}

// Are they on shift right now? (scheduled jobs only.)
export function withinShift(character: string, hour: number): boolean {
  const job = jobFor(character);
  return job.kind === 'scheduled' && hour >= job.startHour && hour < job.endHour;
}

// A short human label for the UI ("On shift 9–18" / "2 pieces / 2 days").
export function jobLabel(character: string): string {
  const job = jobFor(character);
  if (job.kind === 'scheduled') return `Shift ${job.startHour}:00–${job.endHour}:00`;
  return `${job.quota} ${job.quota === 1 ? 'piece' : 'pieces'} / ${job.perDays} days`;
}

// Deliverable workers are paid per shipped piece (a chunk worth roughly a few hours of wage).
export function deliverablePay(character: string): number {
  return Math.round(wageFor(character) * 6);
}

// The bite for falling short: a money penalty and a standing hit, scaled by how scheduled vs
// deliverable jobs differ. Tunable in one place.
export const MISSED_SHIFT_MONEY = 12; // a missed day costs you
export const MISSED_DELIVERABLE_MONEY = 18; // per piece short at cycle end
export const MISSED_SHIFT_STANDING = 6; // standing points lost
export const MISSED_DELIVERABLE_STANDING = 8;
export const STANDING_RECOVERY_PER_DAY = 3; // standing penalty decays as you get back on track
