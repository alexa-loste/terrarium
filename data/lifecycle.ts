// Terrarium v3.0 — AGING (the pure half).
//
// ── The unit problem, and the decision it forced ────────────────────────────────────────────────
//
// The founding cast state their ages IN YEARS, in their own identity text — "I'm Mara, 31, an
// indie founder…" — and that text is read to the model as first-person self-description on every
// single prompt. The world, meanwhile, counts only DAYS (data/clock.ts: one world-day is 24 real
// minutes at speed 1). So the aging unit was already fixed by the prose before any code was
// written: it has to be the YEAR, and the only counter that exists is the day.
//
//   ONE WORLD-DAY IS ONE YEAR OF A CHARACTER'S LIFE.
//
// A day is therefore two things at once: a day of someone's social life (their shift, tonight's
// plans, the overnight reflection) and a year of their biography. That is a deliberate
// compression, not an oversight. The alternative — aging slower than a day — makes the identity
// text lie the moment the sim runs, because a character who says "I'm 31" would be three.
//
// What it costs, stated plainly: a character can hold a conversation on Tuesday and be a year
// older on Wednesday, so nothing in a prompt should ever narrate the gap between two days as
// "yesterday" AND as "last year" at the same time. Nothing does today; keep it that way.
//
// What it buys: the whole arc is watchable. At speed 1 a world-day is 24 real minutes, so the
// oldest founder (Russ, 47) reaches the frail end of a typical lifespan in roughly a dozen real
// hours, and under an hour and a half at speed 8. A model that aged any slower would be a feature
// nobody could ever see working.
//
// This module is pure and dependency-free so it can be tested without Convex. The storage half
// (the `lifecycle` table, seeding, the daily pass) is convex/lifecycle.ts.

// ── The founding cast's ages ────────────────────────────────────────────────────────────────────

// Transcribed from the identity prose in data/characters.ts. This table is a DUPLICATE of a number
// that also lives in that prose, which is exactly the shape that drifts — so data/lifecycle.test.ts
// re-reads the identity strings and asserts every entry here still matches the sentence it came
// from. If someone rewrites a bio and makes Theo 34, that test goes red rather than the town
// quietly disagreeing with itself.
export const FOUNDING_AGES: Record<string, number> = {
  Mara: 31,
  Priya: 34,
  Theo: 29,
  Gloria: 52,
  Naomi: 38,
  Desmond: 44,
  Yuki: 41,
  Russ: 47,
};

// ── Constants ───────────────────────────────────────────────────────────────────────────────────

// Below this age a character exists, moves and is visible, but holds no conversations (alexa's
// decision: a childhood phase, no dialogue). Cheap on the inference budget and true to life.
export const MATURITY_AGE = 16;

// Lifespan is drawn per character at birth and stored, so a cohort seeded together does not die
// together. LIFESPAN_MEAN is the centre of that draw; the min/max clamp exists to keep an
// overridden mean (the tuning knob on the seeder) from producing a nonsense span.
export const LIFESPAN_MEAN = 82;
export const LIFESPAN_SPREAD = 11;
export const LIFESPAN_MIN = 58;
export const LIFESPAN_MAX = 104;

// The last stretch of a life: visible frailty, and the window in which death actually happens.
export const ELDER_WINDOW = 10;

// The per-day chance of dying AT the drawn lifespan. Death is a rising hazard across ELDER_WINDOW
// rather than a cutoff on the drawn number, so nobody dies on a date you could have predicted from
// their row. Consequence worth knowing: because the hazard fires throughout the window, most
// characters die a few years SHORT of their drawn lifespan — `lifespanDays` is the frailty anchor,
// not a promise. See deathHazard for the shape.
export const PEAK_HAZARD = 0.3;

export type LifeStage = 'child' | 'adult' | 'elder';

// ── Age ─────────────────────────────────────────────────────────────────────────────────────────

// Age is DERIVED, never accumulated. There is no counter to increment, nothing to drift, and a
// missed tick costs nothing — a character who was asleep for the pass is still exactly as old as
// the calendar says. bornDay is negative for anyone alive before the world's day 1.
export function ageOn(currentDay: number, bornDay: number): number {
  return Math.max(0, currentDay - bornDay);
}

// The inverse, used when seeding a character who is already partway through a life: the founding
// cast are the ages their bios claim, on the day the seed runs — not on day 1. Seeding a world
// that has already been running for a month must not make Mara 31 + a month old.
export function bornDayForAge(currentDay: number, age: number): number {
  return currentDay - age;
}

export function stageFor(age: number, lifespanDays: number): LifeStage {
  if (age < MATURITY_AGE) return 'child';
  // Deliberately the same threshold as the hazard onset below. The stage a character can FEEL and
  // the hazard that actually kills them are one number, so "they know they're dying" is never
  // decoration bolted onto an unrelated timer.
  if (age >= lifespanDays - ELDER_WINDOW) return 'elder';
  return 'adult';
}

// Per-world-day probability of dying of old age. Zero until frailty begins, then a cubic ramp that
// reaches PEAK_HAZARD exactly at the drawn lifespan and saturates at 1 shortly after — so the
// window is bounded on both sides and no one lingers indefinitely past their span.
export function deathHazard(age: number, lifespanDays: number): number {
  const t = (age - (lifespanDays - ELDER_WINDOW)) / ELDER_WINDOW; // 0 at frailty onset, 1 at span
  if (t <= 0) return 0;
  return Math.min(1, PEAK_HAZARD * t * t * t);
}

// A bell-ish draw without pulling in a stats library: three uniforms summed is close enough to
// normal for this, and unlike a raw uniform it makes the extremes rare rather than routine.
export function drawLifespan(rand: () => number = Math.random, mean = LIFESPAN_MEAN): number {
  const bell = rand() + rand() + rand() - 1.5; // ~-1.5..1.5, peaked at 0
  const drawn = Math.round(mean + bell * LIFESPAN_SPREAD);
  return Math.max(LIFESPAN_MIN, Math.min(LIFESPAN_MAX, drawn));
}

// A character SEEDED partway through a life needs one more constraint that a newborn does not.
// The draw knows nothing about how old they already are, so Gloria — 52 when the world starts —
// could be handed a 58-year span and begin the sim already frail, or die in the first real hour.
// That is not old age; it is a seeding artifact, and it reads as a bug to anyone watching.
//
// So a seeded character is guaranteed this much life left. Deliberately just over ELDER_WINDOW, so
// the guarantee is "you get an adulthood", not "you get a long one" — an unlucky draw still puts
// someone into frailty within a few world-days, which is the fast path to seeing mortality work.
export const MIN_REMAINING_AT_SEED = ELDER_WINDOW + 2;

// Note this may exceed LIFESPAN_MAX for a character seeded near it. That is correct: the clamp
// bounds the DRAW, and a person who is demonstrably already 104 is not evidence against their own
// existence.
export function seedLifespanFor(age: number, drawn: number): number {
  return Math.max(drawn, age + MIN_REMAINING_AT_SEED);
}

// ── Stage transitions ───────────────────────────────────────────────────────────────────────────

// The note handed to the character when they cross into a new stage. It is a CONTEXT line for
// their own journal entry, not the entry itself — the LLM writes the entry in their voice from
// this. Written in the second person because that is how every other journal context in this
// codebase addresses the character.
//
// Returns null when the transition isn't one a person would notice happening to them (nothing
// currently, but a future stage might not be).
export function stageNote(to: LifeStage, age: number): string | null {
  switch (to) {
    case 'adult':
      return `You turned ${age} today. You are not a child any more — people will talk to you like an adult now, and expect one back.`;
    case 'elder':
      return `You turned ${age} today, and something has changed. You are old. Your body is telling you that the years ahead are few, and you are the kind of person who would rather look at that squarely than pretend otherwise.`;
    case 'child':
      return null; // nobody transitions INTO childhood; they're born there
  }
}

// ── Death ───────────────────────────────────────────────────────────────────────────────────────

// Does this character die of old age on this world-day? `roll` is a value in [0,1) supplied by the
// caller rather than drawn here, so the decision is a pure function and the tests can pin the
// boundary exactly instead of sampling and hoping.
//
// Strictly less-than, so a roll of 0 kills only where the hazard is genuinely positive — a
// character with hazard 0 can never die, whatever the roll.
export function diesOfAgeOn(age: number, lifespanDays: number, roll: number): boolean {
  return roll < deathHazard(age, lifespanDays);
}

// The line recorded in the town chronicle. Deliberately plain: the character's own account of
// dying is not this system's job, and inventing one here would put words in their mouth that
// nothing in their history supports.
export function deathNotice(name: string, age: number): string {
  return `${name} died of old age, at ${age}.`;
}
