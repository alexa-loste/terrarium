import { v } from 'convex/values';
import { internalMutation, mutation, query, QueryCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import { playerId } from './aiTown/ids';
import { worldTimeNow } from './clock';
import {
  FOUNDING_AGES,
  LifeStage,
  MATURITY_AGE,
  ageOn,
  bornDayForAge,
  drawLifespan,
  seedLifespanFor,
  stageFor,
  stageNote,
} from '../data/lifecycle';

// Terrarium v3.0 — AGING (the storage half). The pure math, the constants, and the reason a
// world-day is a year of a life are all in data/lifecycle.ts; read that first.
//
// What lives here:
//   • seeding the founding cast, at the ages their own bios claim
//   • the one world-wide daily pass that recomputes everyone's stage
//   • the take-and-clear handoff that lets each character journal their own transition
//   • the reads: one character's row, the whole roster, and the DEAD set that roster
//     enumerators filter on
//
// WHAT THIS DOES NOT DO YET: nothing here kills anybody. `deathHazard` is defined and tested in
// the pure module and is not called from this file. Aging is live; mortality is the next step.

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────

export async function getLifecycle(
  ctx: QueryCtx,
  worldId: Id<'worlds'>,
  pid: string,
): Promise<Doc<'lifecycle'> | null> {
  return await ctx.db
    .query('lifecycle')
    .withIndex('playerId', (q) => q.eq('worldId', worldId).eq('playerId', pid))
    .first();
}

// The set of player ids that are DEAD — deliberately the dead set and not the living one.
//
// Roster enumerators across this codebase mean "everyone in town", and they run against
// playerDescriptions, which outlives the character. If this returned the LIVING and a world had no
// lifecycle rows yet (every world today), every one of those callers would see an empty town. The
// dead set fails the safe way: no rows means nobody is dead, which is exactly the behaviour that
// shipped before this table existed.
export async function deadPlayerIds(
  ctx: QueryCtx,
  worldId: Id<'worlds'>,
): Promise<Set<string>> {
  const rows = await ctx.db
    .query('lifecycle')
    .withIndex('status', (q) => q.eq('worldId', worldId).eq('status', 'dead'))
    .collect();
  return new Set(rows.map((r) => String(r.playerId)));
}

// One character's row plus the numbers derived from it. Null when un-seeded.
export const getForPlayer = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const row = await getLifecycle(ctx, args.worldId, args.playerId);
    if (!row) return null;
    const { day } = await worldTimeNow(ctx, args.worldId);
    const age = ageOn(row.diedDay ?? day, row.bornDay);
    return { ...row, age, stage: stageFor(age, row.lifespanDays), currentDay: day };
  },
});

// The whole town's ages in one call — the live check that aging is actually running:
//   npx convex run lifecycle:roster '{"worldId":"..."}'
export const roster = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('lifecycle')
      .withIndex('playerId', (q) => q.eq('worldId', args.worldId))
      .collect();
    const { day } = await worldTimeNow(ctx, args.worldId);
    return {
      day,
      people: rows
        .map((r) => {
          const age = ageOn(r.diedDay ?? day, r.bornDay);
          return {
            name: r.playerName,
            status: r.status,
            age,
            stage: stageFor(age, r.lifespanDays),
            lifespan: r.lifespanDays,
            bornDay: r.bornDay,
            lastAgedDay: r.lastAgedDay ?? null,
            diedDay: r.diedDay ?? null,
          };
        })
        .sort((a, b) => b.age - a.age),
    };
  },
});

// ── Seeding ─────────────────────────────────────────────────────────────────────────────────────

// Give the founding cast their rows. Idempotent: an existing row is never touched, so re-running
// this can't reset anybody's age or re-roll their lifespan.
//
// Only names in FOUNDING_AGES are seeded. A character born at runtime gets their row AT BIRTH, from
// the birth handler, with a real bornDay and real parents — so if one ever turns up here without a
// row, that is a bug in the birth path and it should stay VISIBLE (reported in `skipped`) rather
// than be papered over by handing them a plausible adult age.
//
// `lifespanMean` overrides the drawn centre for this seed only — the knob for compressing a run.
export const seedLifecycleForWorld = mutation({
  args: { worldId: v.id('worlds'), lifespanMean: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const descriptions = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    // The ages in the bios are true ON THE DAY THE SEED RUNS, not on day 1. Seeding a world that
    // has already been running for a month must not make Mara 31 plus a month.
    const { day } = await worldTimeNow(ctx, args.worldId);

    let seeded = 0;
    const skipped: string[] = [];
    for (const d of descriptions) {
      const age = FOUNDING_AGES[d.name];
      if (age === undefined) {
        if (!(await getLifecycle(ctx, args.worldId, d.playerId))) skipped.push(d.name);
        continue;
      }
      if (await getLifecycle(ctx, args.worldId, d.playerId)) continue;
      const bornDay = bornDayForAge(day, age);
      // seedLifespanFor, not the raw draw: these characters are already partway through a life and
      // must not be handed a span shorter than the one they have already lived.
      const lifespanDays = seedLifespanFor(age, drawLifespan(Math.random, args.lifespanMean));
      await ctx.db.insert('lifecycle', {
        worldId: args.worldId,
        playerId: d.playerId,
        playerName: d.name,
        status: 'alive',
        bornDay,
        lifespanDays,
        maturesDay: bornDay + MATURITY_AGE,
        stage: stageFor(age, lifespanDays),
        lastAgedDay: day,
      });
      seeded++;
    }
    return { day, seeded, skipped };
  },
});

// ── The daily pass ──────────────────────────────────────────────────────────────────────────────

// Recompute every living character's stage for `day`. Called once per world-day from the night
// tick of whichever agent reaches the new day first (convex/aiTown/agentOperations.ts); the rest
// find it already done.
//
// Idempotent on `lastAgedDay`, and that guard is per-row rather than a single world-level marker on
// purpose — a character seeded mid-day, or born mid-day, joins the pass on their own schedule
// instead of being skipped until the next one.
//
// There is nothing to increment. Age is derived from bornDay, so this pass only writes when a
// STAGE actually changes; on an ordinary day it does one cheap read per character and no writes
// beyond the day marker.
export const ageWorld = internalMutation({
  args: { worldId: v.id('worlds'), day: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('lifecycle')
      .withIndex('status', (q) => q.eq('worldId', args.worldId).eq('status', 'alive'))
      .collect();

    const transitions: { name: string; from: LifeStage; to: LifeStage; age: number }[] = [];
    let aged = 0;
    for (const row of rows) {
      if (row.lastAgedDay === args.day) continue; // already run for this day
      const age = ageOn(args.day, row.bornDay);
      const to = stageFor(age, row.lifespanDays);
      const from = row.stage ?? to; // a row from before staging existed starts where it stands
      const patch: Partial<Doc<'lifecycle'>> = { lastAgedDay: args.day, stage: to };
      if (from !== to) {
        const note = stageNote(to, age);
        // Overwrites any note the character hasn't collected yet. Two unread transitions would
        // mean they slept through a whole stage; the newer one is the true one.
        if (note) patch.pendingStageNote = note;
        transitions.push({ name: row.playerName, from, to, age });
      }
      await ctx.db.patch(row._id, patch);
      aged++;
    }
    if (transitions.length) {
      console.log(
        `Day ${args.day}: ${transitions
          .map((t) => `${t.name} ${t.from}→${t.to} at ${t.age}`)
          .join(', ')}`,
      );
    }
    return { aged, transitions };
  },
});

// Read-and-clear this character's pending stage note. Called from their own night tick, which
// writes it up as a journal entry in their voice. Clearing here rather than at the call site is
// what makes it exactly-once: the journal write is best-effort and may fail, and a note that
// survived a failure would be re-journalled every night forever.
export const takeStageNote = internalMutation({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const row = await getLifecycle(ctx, args.worldId, args.playerId);
    if (!row?.pendingStageNote) return null;
    const note = row.pendingStageNote;
    await ctx.db.patch(row._id, { pendingStageNote: undefined });
    return note;
  },
});
