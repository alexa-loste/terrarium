import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  QueryCtx,
} from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import { playerId } from './aiTown/ids';
import { worldTimeNow } from './clock';
import { insertInput } from './aiTown/insertInput';
import { internal } from './_generated/api';
import { fetchEmbedding } from './util/llm';
import {
  FOUNDING_AGES,
  LifeStage,
  MATURITY_AGE,
  ageOn,
  bornDayForAge,
  deathNotice,
  diesOfAgeOn,
  griefBandFor,
  witnessImportance,
  witnessMemory,
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
// Death by OLD AGE only. Starvation is deliberately not wired: agents hold 126-4078 money against
// a 4-16 meal, so hunger provably cannot bite until the economy is tightened. That was measured,
// not assumed, and it is alexa's call when to change it.

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

// The one world-day pass: everyone ages, some cross into a new stage, and some die of old age.
// Called once per world-day from the night tick of whichever agent reaches the new day first
// (convex/aiTown/agentOperations.ts); the rest find it already done.
//
// Idempotent on `lastAgedDay`, and that guard is per-row rather than a single world-level marker on
// purpose — a character seeded mid-day, or born mid-day, joins the pass on their own schedule
// instead of being skipped until the next one. It is also what makes the death roll happen exactly
// ONCE per character per day: a second call the same day rolls for nobody.
//
// Aging itself writes almost nothing. Age is derived from bornDay, so on an ordinary day this does
// one cheap read per character, one day marker, and no more.
export const dailyLifecycle = internalMutation({
  args: { worldId: v.id('worlds'), day: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('lifecycle')
      .withIndex('status', (q) => q.eq('worldId', args.worldId).eq('status', 'alive'))
      .collect();

    const transitions: { name: string; from: LifeStage; to: LifeStage; age: number }[] = [];
    const deaths: { name: string; age: number }[] = [];
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

      // The death roll. Zero hazard for the whole of an ordinary life, so this is a no-op for
      // almost everyone almost every day; it only bites inside ELDER_WINDOW, and it is the same
      // threshold that put them in the `elder` stage above — a character can never die on a day
      // they could not already feel coming.
      if (diesOfAgeOn(age, row.lifespanDays, Math.random())) {
        await kill(ctx, args.worldId, row, args.day, age, 'age');
        deaths.push({ name: row.playerName, age });
        aged++;
        continue; // the row is written by `kill`; don't also write the alive patch over it
      }

      await ctx.db.patch(row._id, patch);
      aged++;
    }

    // A character marked dead whose player is somehow still in the world gets another `die`.
    // The two writes are not one transaction — the row is patched here, the world is changed by an
    // input the engine applies later — so a lost input would otherwise leave a dead person walking
    // around forever. `die` is idempotent, and the window is bounded so this doesn't grow into a
    // daily broadcast about everyone who has ever died.
    const reswept = await resweepRecentDead(ctx, args.worldId, args.day);

    if (transitions.length) {
      console.log(
        `Day ${args.day}: ${transitions
          .map((t) => `${t.name} ${t.from}→${t.to} at ${t.age}`)
          .join(', ')}`,
      );
    }
    if (deaths.length) {
      console.warn(
        `Day ${args.day}: ${deaths.map((d) => deathNotice(d.name, d.age)).join(' ')}`,
      );
    }
    return { aged, transitions, deaths, reswept };
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

// ── Dying ───────────────────────────────────────────────────────────────────────────────────────

// How many world-days after a death we keep re-sending `die` for a row whose player is somehow
// still present. Long enough to survive a lost input, short enough that it never becomes a daily
// announcement about the whole graveyard.
const RESWEEP_DAYS = 3;

// Mark a character dead and ask the engine to remove them.
//
// The ORDER matters and it is deliberate. The row is marked dead FIRST, in this transaction, and
// the `die` input is queued for the engine to apply on a later tick. Those cannot be made atomic —
// the world document is owned by the engine and rewritten wholesale by `saveWorld`, so writing to
// it from here would be clobbered. Marking first means the worst case is a character recorded as
// dead who is briefly still standing there, which `resweepRecentDead` fixes. Queueing first would
// give the opposite and much worse failure: someone removed from the world with no record of
// having died, no cause, and no age — unrecoverable, because the evidence left with them.
//
// What deliberately SURVIVES: their playerDescription (survivors' memory pipeline resolves a dead
// character's name through it), and every memory they ever formed. See aiTown/lifeInputs.ts.
async function kill(
  ctx: any,
  worldId: Id<'worlds'>,
  row: Doc<'lifecycle'>,
  day: number,
  age: number,
  cause: string,
): Promise<void> {
  await ctx.db.patch(row._id, {
    status: 'dead',
    diedDay: day,
    cause,
    lastAgedDay: day,
    // Nobody collects a stage note after dying, and leaving one set would strand it forever.
    pendingStageNote: undefined,
  });
  await ctx.db.insert('townEvents', {
    worldId,
    ts: Date.now(),
    kind: 'system',
    summary: deathNotice(row.playerName, age),
    playerId: row.playerId,
    playerName: row.playerName,
    emoji: '🕯️',
  });
  await insertInput(ctx, worldId, 'die', { playerId: row.playerId });
  // The survivors' half. Scheduled, not awaited: memories need embeddings, embeddings need an
  // action, and this is a mutation.
  await ctx.scheduler.runAfter(0, internal.lifecycle.recordWitnesses, {
    worldId,
    deceasedPlayerId: row.playerId,
    deceasedName: row.playerName,
    age,
  });
}

async function resweepRecentDead(
  ctx: any,
  worldId: Id<'worlds'>,
  day: number,
): Promise<number> {
  const dead = await ctx.db
    .query('lifecycle')
    .withIndex('status', (q: any) => q.eq('worldId', worldId).eq('status', 'dead'))
    .collect();
  let sent = 0;
  for (const row of dead as Doc<'lifecycle'>[]) {
    if (row.diedDay === undefined || day - row.diedDay > RESWEEP_DAYS) continue;
    if (row.diedDay === day) continue; // just killed above; the first input is still in flight
    await insertInput(ctx, worldId, 'die', { playerId: row.playerId });
    sent++;
  }
  return sent;
}

// Kill a named character right now, for watching the mechanic work without waiting out a lifespan.
// Real deaths come from the daily roll; this is the same code path, so what you see here is what
// happens on its own.
//
//   npx convex run lifecycle:forceDeath '{"worldId":"...","name":"Russ"}'
export const forceDeath = internalMutation({
  args: { worldId: v.id('worlds'), name: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('lifecycle')
      .withIndex('status', (q) => q.eq('worldId', args.worldId).eq('status', 'alive'))
      .collect();
    const row = rows.find((r) => r.playerName === args.name);
    if (!row) return { killed: null, reason: `no living character named ${args.name}` };
    const { day } = await worldTimeNow(ctx, args.worldId);
    const age = ageOn(day, row.bornDay);
    await kill(ctx, args.worldId, row, day, age, 'age');
    return { killed: row.playerName, age, day };
  },
});

// Everyone still alive and still in the world, with the agent id their memories hang off.
//
// Reads the world document for the agent ids and `lifecycle` for aliveness, and requires BOTH:
// the deceased's row is marked dead in the same transaction as the death, but the `die` input that
// removes them from the world is applied by the engine on a later tick. For the moments in between
// they are dead on paper and present in the world, and a survivor list built from either source
// alone would include them in their own funeral.
// Return type annotated deliberately — see the note on recordWitnesses below.
export const survivorsFor = internalQuery({
  args: { worldId: v.id('worlds'), excluding: playerId },
  handler: async (ctx, args): Promise<{ playerId: string; agentId: string }[]> => {
    const world = await ctx.db.get(args.worldId);
    if (!world) return [];
    const dead = await deadPlayerIds(ctx, args.worldId);
    const out: { playerId: string; agentId: string }[] = [];
    for (const agent of world.agents) {
      const pid = String(agent.playerId);
      if (pid === String(args.excluding) || dead.has(pid)) continue;
      out.push({ playerId: pid, agentId: String(agent.id) });
    }
    return out;
  },
});

// Give every survivor a memory of the death, weighted by how well they knew them.
//
// Scheduled from `kill` rather than done inline because a memory needs an EMBEDDING, which needs
// an action, and `kill` runs inside a mutation. Best-effort per survivor: one failed embedding
// must not cost the rest of the town their memory of the person.
// The explicit return-type annotations on this action and on `survivorsFor` are LOad-BEARING, not
// decoration. This module reaches for `internal` to schedule itself and to call
// agent.memory.insertMemory, and the generated API type includes this module, so inference goes in
// a circle. TypeScript resolves that by falling back to `any` — and the errors surface as six
// implicit-any complaints in agent/memory.ts and agent/conversation.ts, files that have nothing to
// do with it. Annotating the boundary stops the traversal.
//
// I first blamed the import in conversation.ts and rewrote it to read the table inline. That was
// wrong: putting the import back once these annotations existed typechecks fine. The inline query
// and its confident explanation are both reverted.
export const recordWitnesses = internalAction({
  args: {
    worldId: v.id('worlds'),
    deceasedPlayerId: playerId,
    deceasedName: v.string(),
    age: v.number(),
  },
  handler: async (ctx, args): Promise<{ recorded: number; survivors: number }> => {
    const survivors: { playerId: string; agentId: string }[] = await ctx.runQuery(
      internal.lifecycle.survivorsFor,
      {
        worldId: args.worldId,
        excluding: args.deceasedPlayerId,
      },
    );
    let recorded = 0;
    for (const s of survivors) {
      try {
        const bond = await ctx.runQuery(internal.relationships.edgeFor, {
          worldId: args.worldId,
          fromPlayerId: s.playerId,
          toPlayerId: args.deceasedPlayerId,
        });
        const band = griefBandFor(bond);
        const description = witnessMemory(args.deceasedName, args.age, band);
        const { embedding } = await fetchEmbedding(description);
        await ctx.runMutation(internal.agent.memory.insertMemory, {
          agentId: s.agentId,
          playerId: s.playerId,
          description,
          importance: witnessImportance(band),
          lastAccess: Date.now(),
          // A memory ABOUT the deceased. The existing 'relationship' shape means exactly this, and
          // it is what lets a survivor's recall surface them by name years later.
          data: { type: 'relationship', playerId: args.deceasedPlayerId },
          embedding,
        });
        recorded++;
      } catch (e) {
        console.error(`witness memory failed for ${s.playerId}`, e);
      }
    }
    console.log(`${args.deceasedName}: ${recorded}/${survivors.length} survivors remember.`);
    return { recorded, survivors: survivors.length };
  },
});
