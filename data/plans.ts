// Terrarium v2.0 — SHARED PLANS (gatherings).
//
// Pure, dependency-free helpers for the shared-event-planning feature. The world has no
// calendar months — time is a plain world-DAY counter (see data/clock.ts). A plan is anchored
// to an ABSOLUTE world-day; the detector extracts a relative offset ("in a couple days") from a
// conversation and we add it to the current day. Both convex/plans.ts and the React UI share
// these so "Day 11 (in 2 days)" reads the same everywhere.

// How many days ahead a plan can be made. The detector is told to clamp to this; anything
// vaguer than ~a week reads as aspirational, not a real commitment worth tracking.
export const MAX_PLAN_LOOKAHEAD_DAYS = 7;

// Only inject a plan into prompts once it's within this horizon (and not past). Keeps the
// "coming up" list short and relevant — agents shouldn't obsess over something a week out.
export const PLAN_VISIBLE_WITHIN_DAYS = 3;

// Don't run plan-detection on a conversation shorter than this — a two-line hello rarely
// produces a real commitment, and the LLM call isn't free on the local model.
export const MIN_MESSAGES_FOR_PLAN = 4;

// Cooldown so a chatty pair doesn't mint a near-duplicate plan every time they talk.
export const PLAN_DETECT_COOLDOWN_MS = 4 * 60 * 1000;

// A human label for when a plan lands, relative to "now". today/tomorrow/in N days, plus the
// optional time of day. Used by both the prompt injector and the UI.
export function planWhenLabel(planDay: number, currentDay: number, hour?: number): string {
  const delta = planDay - currentDay;
  let when: string;
  if (delta <= 0) when = 'today';
  else if (delta === 1) when = 'tomorrow';
  else when = `in ${delta} days`;
  const at = typeof hour === 'number' ? ` at ${String(hour).padStart(2, '0')}:00` : '';
  return `${when}${at}`;
}

// Clamp a detected day-offset into the sane window. Returns null if it isn't a real future
// commitment (0 or negative offset, or absurdly far out).
export function clampPlanOffset(offsetDays: number): number | null {
  if (!Number.isFinite(offsetDays)) return null;
  const n = Math.round(offsetDays);
  if (n < 1) return null;
  if (n > MAX_PLAN_LOOKAHEAD_DAYS) return MAX_PLAN_LOOKAHEAD_DAYS;
  return n;
}
