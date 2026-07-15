import { v } from 'convex/values';
import { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, query } from './_generated/server';
import { playerId } from './aiTown/ids';
import {
  alignment,
  areRivals,
  commitmentBand,
  CURIOUS_AT,
  CURIOUS_SEED,
  DROP_BELOW,
  FOUND_INTENSITY,
  FOUNDER_COMMIT,
  MEMBER_AT,
  nightlyCommitment,
  poleLabel,
  priorPole,
  reactionToMove,
  RECRUIT_COMMIT,
} from '../data/factions';

// Terrarium v2.3 — FACTIONS storage + dynamics. The group tier of the sim.
//
// Affiliation lives in `factionTies` as a commitment score (0..100) per (faction, character). The
// dynamics — how that score moves — are pure functions in data/factions.ts; this module is the thin
// Convex layer that reads beliefs/relationships, applies them, and bookkeeps role + join/leave
// crossings. The only LLM calls (founding text, public-stance text) live in agentComms.ts.

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

// ── internal read helpers ───────────────────────────────────────────────────────────────────────

async function activeFactions(ctx: any, worldId: Id<'worlds'>): Promise<Doc<'factions'>[]> {
  const all = await ctx.db
    .query('factions')
    .withIndex('worldId', (q: any) => q.eq('worldId', worldId))
    .collect();
  return all.filter((f: Doc<'factions'>) => f.status === 'active');
}

async function tiesOf(ctx: any, worldId: Id<'worlds'>, pid: string): Promise<Doc<'factionTies'>[]> {
  return await ctx.db
    .query('factionTies')
    .withIndex('byPlayer', (q: any) => q.eq('worldId', worldId).eq('playerId', pid))
    .collect();
}

async function tiesFor(
  ctx: any,
  worldId: Id<'worlds'>,
  factionId: Id<'factions'>,
): Promise<Doc<'factionTies'>[]> {
  return await ctx.db
    .query('factionTies')
    .withIndex('byFaction', (q: any) => q.eq('worldId', worldId).eq('factionId', factionId))
    .collect();
}

// A character's live conviction on a topic (0 if they hold no belief there). Strength only — the
// SIDE comes from the stable prior in data/factions.ts.
async function convictionOn(
  ctx: any,
  worldId: Id<'worlds'>,
  pid: string,
  topic: string,
): Promise<number> {
  const beliefs = await ctx.db
    .query('beliefs')
    .withIndex('author', (q: any) => q.eq('worldId', worldId).eq('playerId', pid))
    .collect();
  const hit = beliefs.find((b: Doc<'beliefs'>) => b.topic.toLowerCase() === topic.toLowerCase());
  return hit ? hit.conviction : 0;
}

function roleFor(commitment: number, isFounder: boolean): 'founder' | 'member' | 'curious' {
  if (isFounder) return 'founder';
  return commitment >= MEMBER_AT ? 'member' : 'curious';
}

// Find the rival of a faction among the active set (same topic, opposite bank).
function rivalOf(faction: Doc<'factions'>, all: Doc<'factions'>[]): Doc<'factions'> | null {
  return all.find((f) => f._id !== faction._id && areRivals(faction, f)) ?? null;
}

// ── founding ─────────────────────────────────────────────────────────────────────────────────────

// Found a faction around a charged conviction. If an aligned faction already exists on this bank of
// the fault line, the would-be founder JOINS it instead (you don't start a second identical group).
// `recruits` are the like-minded allies the founder named at birth — they come in as members.
export const createFaction = internalMutation({
  args: {
    worldId: v.id('worlds'),
    name: v.string(),
    topic: v.string(),
    pole: v.number(),
    premise: v.string(),
    founderPlayerId: playerId,
    founderName: v.string(),
    foundedDay: v.number(),
    recruits: v.array(v.object({ playerId, playerName: v.string() })),
  },
  handler: async (ctx, args) => {
    const all = await activeFactions(ctx, args.worldId);
    // Already a faction on this exact bank? Fold the founder in rather than duplicate.
    const existing = all.find(
      (f) => f.topic === args.topic && Math.sign(f.pole) === Math.sign(args.pole),
    );
    if (existing) {
      await ensureTie(ctx, args.worldId, existing._id, args.founderPlayerId, args.founderName, {
        atLeast: RECRUIT_COMMIT,
        day: args.foundedDay,
      });
      return { factionId: existing._id, created: false };
    }

    const now = Date.now();
    const factionId = await ctx.db.insert('factions', {
      worldId: args.worldId,
      name: args.name.slice(0, 60),
      topic: args.topic,
      pole: Math.sign(args.pole) || 1,
      premise: args.premise.slice(0, 240),
      founderPlayerId: args.founderPlayerId,
      founderName: args.founderName,
      foundedDay: args.foundedDay,
      intensity: FOUND_INTENSITY,
      status: 'active',
      createdAt: now,
    });

    await ctx.db.insert('factionTies', {
      worldId: args.worldId,
      factionId,
      playerId: args.founderPlayerId,
      playerName: args.founderName,
      commitment: FOUNDER_COMMIT,
      role: 'founder',
      joinedDay: args.foundedDay,
      updatedAt: now,
    });
    for (const r of args.recruits) {
      if (r.playerId === args.founderPlayerId) continue;
      await ctx.db.insert('factionTies', {
        worldId: args.worldId,
        factionId,
        playerId: r.playerId,
        playerName: r.playerName,
        commitment: RECRUIT_COMMIT,
        role: 'member',
        joinedDay: args.foundedDay,
        updatedAt: now,
      });
    }

    const rival = all.find((f) => areRivals({ topic: args.topic, pole: args.pole }, f)) ?? null;
    await ctx.db.insert('townEvents', {
      worldId: args.worldId,
      ts: now,
      kind: 'system',
      playerId: args.founderPlayerId,
      playerName: args.founderName,
      emoji: '🤝',
      summary:
        `${args.founderName} started ${args.name} — ${poleLabel(args.topic, args.pole)}` +
        (rival ? `, squaring off against ${rival.name}.` : '.'),
    });
    return { factionId, created: true };
  },
});

// Create-or-raise a tie to at least `atLeast` commitment (used when folding an aligned person in).
async function ensureTie(
  ctx: any,
  worldId: Id<'worlds'>,
  factionId: Id<'factions'>,
  pid: string,
  name: string,
  opts: { atLeast: number; day: number },
) {
  const existing = (await tiesFor(ctx, worldId, factionId)).find((t) => t.playerId === pid);
  const now = Date.now();
  if (existing) {
    if (existing.commitment < opts.atLeast) {
      await ctx.db.patch(existing._id, {
        commitment: opts.atLeast,
        role: roleFor(opts.atLeast, existing.role === 'founder'),
        updatedAt: now,
      });
    }
    return;
  }
  await ctx.db.insert('factionTies', {
    worldId,
    factionId,
    playerId: pid,
    playerName: name,
    commitment: opts.atLeast,
    role: roleFor(opts.atLeast, false),
    joinedDay: opts.day,
    updatedAt: now,
  });
}

// ── public stance (a faction "does something" members react to) ──────────────────────────────────

// Record a faction's public stance and ripple it through commitments: its own members approve or
// disapprove (and the over-eager get pushed away if it's more extreme than they are); the rival's
// members get hardened (rally). Returns crossings worth narrating.
export const recordMove = internalMutation({
  args: {
    worldId: v.id('worlds'),
    factionId: v.id('factions'),
    stance: v.string(),
    moveIntensity: v.number(),
    currentDay: v.number(),
  },
  handler: async (ctx, args) => {
    const faction = await ctx.db.get(args.factionId);
    if (!faction || faction.status !== 'active') return { joined: [], left: [] };
    // The faction BECOMES what it does — ease its standing intensity toward the move's heat.
    const newIntensity = clamp(faction.intensity + (args.moveIntensity - faction.intensity) * 0.5);
    await ctx.db.patch(args.factionId, {
      intensity: newIntensity,
      lastStance: args.stance.slice(0, 240),
      lastMoveDay: args.currentDay,
    });

    const move = { pole: faction.pole, intensity: args.moveIntensity };
    const joined: string[] = [];
    const left: string[] = [];

    // Own members react.
    for (const tie of await tiesFor(ctx, args.worldId, args.factionId)) {
      const conv = await convictionOn(ctx, args.worldId, tie.playerId, faction.topic);
      const delta = reactionToMove(priorPole(tie.playerName, faction.topic), conv, move, 'own');
      await applyCommitmentDelta(ctx, tie, delta, args.currentDay, joined, left, faction.name);
    }

    // The rival's members get rallied by a loud opposing move.
    const all = await activeFactions(ctx, args.worldId);
    const rival = rivalOf(faction, all);
    if (rival) {
      for (const tie of await tiesFor(ctx, args.worldId, rival._id)) {
        const conv = await convictionOn(ctx, args.worldId, tie.playerId, rival.topic);
        const delta = reactionToMove(priorPole(tie.playerName, rival.topic), conv, move, 'rival');
        await applyCommitmentDelta(ctx, tie, delta, args.currentDay, joined, left, rival.name);
      }
    }

    // The stance itself is published to the feed by the caller (which mirrors to the chronicle),
    // so we don't double-log it here.
    return { joined, left };
  },
});

// Apply a commitment delta to a tie, update role, and record a join/leave crossing. Withered ties
// (below DROP_BELOW) are removed.
async function applyCommitmentDelta(
  ctx: any,
  tie: Doc<'factionTies'>,
  delta: number,
  day: number,
  joined: string[],
  left: string[],
  factionName: string,
) {
  if (!delta) return;
  const before = tie.commitment;
  const after = clamp(before + delta);
  const isFounder = tie.role === 'founder';
  if (after < DROP_BELOW && !isFounder) {
    await ctx.db.delete(tie._id);
    left.push(`${tie.playerName} drifted out of ${factionName}`);
    return;
  }
  await ctx.db.patch(tie._id, {
    commitment: after,
    role: roleFor(after, isFounder),
    updatedAt: Date.now(),
  });
  if (before < MEMBER_AT && after >= MEMBER_AT) joined.push(`${tie.playerName} joined ${factionName}`);
  if (before >= MEMBER_AT && after < MEMBER_AT && !isFounder)
    left.push(`${tie.playerName} pulled back from ${factionName}`);
}

// ── nightly affiliation recompute (per player) ───────────────────────────────────────────────────

// Once a night per character: ease every tie toward the equilibrium implied by their CURRENT
// beliefs (so drift quietly strengthens/erodes ties), nudge by social pull from co-members, seed a
// curiosity tie toward any faction their convictions now align with, and resolve role/crossings.
export const nightlyAffiliation = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    playerName: v.string(),
    currentDay: v.number(),
  },
  handler: async (ctx, args) => {
    const joined: string[] = [];
    const left: string[] = [];
    const all = await activeFactions(ctx, args.worldId);
    const myTies = await tiesOf(ctx, args.worldId, args.playerId);
    const tiedFactionIds = new Set(myTies.map((t) => String(t.factionId)));

    // My outbound warmth, for the social-pull term.
    const outbound = await ctx.db
      .query('relationships')
      .withIndex('outbound', (q: any) => q.eq('worldId', args.worldId).eq('fromPlayerId', args.playerId))
      .collect();
    const affinityTo = new Map<string, number>();
    for (const e of outbound) affinityTo.set(String(e.toPlayerId), e.affinity);

    for (const tie of myTies) {
      const faction = all.find((f) => f._id === tie.factionId);
      if (!faction) {
        await ctx.db.delete(tie._id); // faction dissolved
        continue;
      }
      const conv = await convictionOn(ctx, args.worldId, args.playerId, faction.topic);
      const align = alignment(priorPole(args.playerName, faction.topic), conv, faction);

      // Social pull: average warmth toward my co-members (-1..1).
      const co = (await tiesFor(ctx, args.worldId, faction._id)).filter(
        (t) => t.playerId !== args.playerId,
      );
      let social = 0;
      if (co.length) {
        const avg =
          co.reduce((s, t) => s + ((affinityTo.get(String(t.playerId)) ?? 50) - 50) / 50, 0) /
          co.length;
        social = Math.max(-1, Math.min(1, avg));
      }

      const after = nightlyCommitment(tie.commitment, align, social);
      const before = tie.commitment;
      const isFounder = tie.role === 'founder';
      if (after < DROP_BELOW && !isFounder) {
        await ctx.db.delete(tie._id);
        left.push(`${args.playerName} drifted out of ${faction.name}`);
        continue;
      }
      await ctx.db.patch(tie._id, {
        commitment: after,
        role: roleFor(after, isFounder),
        updatedAt: Date.now(),
      });
      if (before < MEMBER_AT && after >= MEMBER_AT) joined.push(`${args.playerName} joined ${faction.name}`);
      if (before >= MEMBER_AT && after < MEMBER_AT && !isFounder)
        left.push(`${args.playerName} pulled back from ${faction.name}`);
    }

    // Curiosity: a faction I'm NOT tied to but now strongly align with pulls at me (a secondary
    // interest — "drawn toward"). Seed a low tie so it can grow or fade on its own.
    for (const f of all) {
      if (tiedFactionIds.has(String(f._id))) continue;
      const mine = priorPole(args.playerName, f.topic);
      if (mine == null || Math.sign(mine) !== Math.sign(f.pole)) continue;
      const conv = await convictionOn(ctx, args.worldId, args.playerId, f.topic);
      const align = alignment(mine, conv, f);
      if (align > 0.45) {
        await ctx.db.insert('factionTies', {
          worldId: args.worldId,
          factionId: f._id,
          playerId: args.playerId,
          playerName: args.playerName,
          commitment: CURIOUS_SEED,
          role: 'curious',
          joinedDay: args.currentDay,
          updatedAt: Date.now(),
        });
      }
    }

    return { joined, left };
  },
});

// ── reads for prompts + UI ───────────────────────────────────────────────────────────────────────

// What the prompt layer needs: the character's PRIMARY faction (highest commitment, member-band),
// who else is in it, the rival, and any secondary "drawn toward" pulls.
export const forPlayer = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const ties = (await tiesOf(ctx, args.worldId, args.playerId)).sort(
      (a, b) => b.commitment - a.commitment,
    );
    if (!ties.length) return null;
    const all = await activeFactions(ctx, args.worldId);
    const top = ties.find((t) => t.commitment >= CURIOUS_AT);
    if (!top) return null;
    const faction = all.find((f) => f._id === top.factionId);
    if (!faction) return null;

    const members = (await tiesFor(ctx, args.worldId, faction._id))
      .filter((t) => t.playerId !== args.playerId && t.commitment >= MEMBER_AT)
      .map((t) => t.playerName);
    const rival = rivalOf(faction, all);
    const drawnToward = ties
      .filter((t) => t.factionId !== faction._id && t.commitment >= CURIOUS_AT)
      .map((t) => all.find((f) => f._id === t.factionId)?.name)
      .filter((n): n is string => !!n);

    return {
      name: faction.name,
      premise: faction.premise,
      topic: faction.topic,
      pole: faction.pole,
      poleLabel: poleLabel(faction.topic, faction.pole),
      role: top.role,
      commitment: Math.round(top.commitment),
      band: commitmentBand(top.commitment),
      members,
      rival: rival ? { name: rival.name, premise: rival.premise } : null,
      drawnToward,
    };
  },
});

// UI: a character's full affiliation picture — every tie with its band, plus each faction's rival.
export const getForPlayer = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const ties = (await tiesOf(ctx, args.worldId, args.playerId)).sort(
      (a, b) => b.commitment - a.commitment,
    );
    const all = await activeFactions(ctx, args.worldId);
    return ties
      .map((t) => {
        const f = all.find((x) => x._id === t.factionId);
        if (!f) return null;
        const rival = rivalOf(f, all);
        return {
          factionId: f._id,
          name: f.name,
          premise: f.premise,
          topic: f.topic,
          poleLabel: poleLabel(f.topic, f.pole),
          intensity: Math.round(f.intensity),
          commitment: Math.round(t.commitment),
          band: commitmentBand(t.commitment),
          role: t.role,
          rival: rival?.name ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  },
});

// UI: the town's faction map — every active faction with its members (sorted by commitment), heat,
// last stance, and rival.
export const listFactions = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const all = await activeFactions(ctx, args.worldId);
    const out = [];
    for (const f of all) {
      const members = (await tiesFor(ctx, args.worldId, f._id))
        .sort((a, b) => b.commitment - a.commitment)
        .map((t) => ({
          name: t.playerName,
          commitment: Math.round(t.commitment),
          role: t.role,
          band: commitmentBand(t.commitment),
        }));
      const rival = rivalOf(f, all);
      out.push({
        factionId: f._id,
        name: f.name,
        premise: f.premise,
        topic: f.topic,
        poleLabel: poleLabel(f.topic, f.pole),
        intensity: Math.round(f.intensity),
        lastStance: f.lastStance ?? null,
        founderName: f.founderName,
        members,
        rival: rival?.name ?? null,
      });
    }
    return out;
  },
});

// For maybeFormFaction: is this player already anchored in a faction (member-band) on this topic?
export const membershipSnapshot = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const ties = await tiesOf(ctx, args.worldId, args.playerId);
    const all = await activeFactions(ctx, args.worldId);
    const topics = new Set<string>();
    let anyMember = false;
    for (const t of ties) {
      const f = all.find((x) => x._id === t.factionId);
      if (f) topics.add(f.topic);
      if (t.commitment >= MEMBER_AT) anyMember = true;
    }
    // Topics that already have an active faction on EACH bank (so we don't double-found).
    const banks = all.map((f) => `${f.topic}:${Math.sign(f.pole)}`);
    return { memberTopics: [...topics], anyMember, banks };
  },
});

// For maybeFactionMove: the active faction this player most leads (founder/highest commitment), if
// any, so they can speak for it.
export const leadFactionFor = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const ties = (await tiesOf(ctx, args.worldId, args.playerId))
      .filter((t) => t.commitment >= MEMBER_AT)
      .sort((a, b) => (b.role === 'founder' ? 1 : 0) - (a.role === 'founder' ? 1 : 0) || b.commitment - a.commitment);
    if (!ties.length) return null;
    const f = await ctx.db.get(ties[0].factionId);
    if (!f || f.status !== 'active') return null;
    const all = await activeFactions(ctx, args.worldId);
    const rival = rivalOf(f, all);
    return {
      factionId: f._id,
      name: f.name,
      premise: f.premise,
      topic: f.topic,
      pole: f.pole,
      poleLabel: poleLabel(f.topic, f.pole),
      intensity: f.intensity,
      role: ties[0].role,
      rivalName: rival?.name ?? null,
      lastMoveDay: f.lastMoveDay ?? null,
    };
  },
});
