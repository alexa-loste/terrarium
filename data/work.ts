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

import { wageFor, moneyStress, costOfLivingFor } from './economy';
import { driveSeedFor, workOverLeisureFor, securityWeightFor } from './drives';

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
const DEFAULT_SHIFT = { startHour: 9, endHour: 17 };

// A per-agent override, read from the `agentTraits` DB table by convex/agentTraits.ts and passed
// down. `data/` stays pure — this is just the row's shape. Its fields are all optional because the
// stored table's are; missing pieces fall back to the generic job, never to the name table (a row,
// when present, is authoritative — that's what lets a runtime-born character have a real job).
export type JobTraits = {
  job?: {
    kind: 'scheduled' | 'deliverable';
    startHour?: number;
    endHour?: number;
    quota?: number;
    perDays?: number;
  } | null;
};

export function jobFor(character: string, traits?: JobTraits | null): Job {
  const j = traits?.job;
  if (j) {
    return j.kind === 'scheduled'
      ? {
          kind: 'scheduled',
          startHour: j.startHour ?? DEFAULT_SHIFT.startHour,
          endHour: j.endHour ?? DEFAULT_SHIFT.endHour,
        }
      : { kind: 'deliverable', quota: j.quota ?? 1, perDays: j.perDays ?? 2 };
  }
  if (traits) return DEFAULT_JOB; // a row with no job: the generic obligation, not a name lookup
  return JOBS[character] ?? DEFAULT_JOB;
}

export function isScheduled(character: string, traits?: JobTraits | null): boolean {
  return jobFor(character, traits).kind === 'scheduled';
}

// v2.9 — how strongly this character is pulled to actually GO WORK right now (0..1). The point
// (per alexa): work should happen because it MATTERS to them, not on a flat dice roll. Three
// real-life pressures, just like irl:
//   - personality: their plain work-ethic / ambition (workOverLeisureFor) — the floor.
//   - finance: a thin wallet relative to their cost of living pushes them to earn (moneyStress).
//   - catch-up: already behind on the obligation → real pressure to make it up.
// Low-pressure characters skip more, drift behind, and the catch-up term then raises their pull —
// an emergent negative-feedback loop instead of everyone uniformly failing. The clamp keeps a
// little humanity at both ends: even a workaholic sometimes detours, even a slacker sometimes shows.
export function workPull(character: string, money: number, behind: boolean): number {
  const profile = driveSeedFor(character)?.profile ?? {};
  const ethic = workOverLeisureFor(profile); // ~0..1, personality
  const finance = Math.min(
    1,
    moneyStress(money, costOfLivingFor(character), securityWeightFor(profile)) / 18,
  );
  const catchUp = behind ? 0.3 : 0;
  return Math.max(0.08, Math.min(0.96, ethic + finance * 0.4 + catchUp - 0.05));
}

// v2.9 — once you're actually on the clock, how much do you keep your head down rather than let a
// conversation pull you away? This is the steady-state FOCUS while working (distinct from workPull,
// the pull to GO to work in the first place). Same personality root: a diligent character mostly
// declines to start chatting on shift; an easily-distracted one socializes more. Clamped so even a
// workaholic occasionally chats (0.9, not 1) and even a slacker keeps their head down sometimes
// (0.45) — coworkers are still human, and a totally chat-free workplace would read as dead.
export function workFocus(character: string): number {
  const profile = driveSeedFor(character)?.profile ?? {};
  const ethic = workOverLeisureFor(profile); // ~0..1, personality
  return Math.max(0.45, Math.min(0.9, 0.5 + ethic * 0.45));
}

// Are they on shift right now? (scheduled jobs only.)
export function withinShift(character: string, hour: number, traits?: JobTraits | null): boolean {
  const job = jobFor(character, traits);
  return job.kind === 'scheduled' && hour >= job.startHour && hour < job.endHour;
}

// v2.3 — pick a sensible hour for a gathering the host is throwing: in the EVENING (after the
// workday, before night) and never during the host's own shift. `pick01` is a 0..1 source the caller
// supplies (Math.random) so the slot varies. Night is hour<6 or hour>=22; evening proper is 18–21,
// which is when most people are off work and around — so that's the window we aim for.
export function gatheringHourFor(
  character: string,
  pick01: number,
  traits?: JobTraits | null,
): number {
  const job = jobFor(character, traits);
  // Start no earlier than 18 (evening), and after a scheduled host's shift ends if that's later.
  const earliest = job.kind === 'scheduled' ? Math.max(18, job.endHour) : 18;
  const latest = 21; // last hour before night (22:00)
  if (earliest >= latest) return latest; // long shift (e.g. ends 20) → squeeze into 21
  const span = latest - earliest;
  return earliest + Math.round(Math.max(0, Math.min(1, pick01)) * span);
}

// Clamp an hour agreed in conversation out of the dead of night onto a reasonable evening time, so
// two people don't "plan" to meet at 3am. Daytime/evening hours pass through untouched.
export function sensiblePlanHour(hour: number): number {
  if (hour >= 6 && hour < 22) return hour; // any waking hour is fine for a casual plan
  return 19; // night → bump to a normal evening hour
}

// A short human label for the UI ("On shift 9–18" / "2 pieces / 2 days").
export function jobLabel(character: string, traits?: JobTraits | null): string {
  const job = jobFor(character, traits);
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
