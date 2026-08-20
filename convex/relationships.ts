import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from './_generated/server';
import { playerId } from './aiTown/ids';
import { CHARGED_TOPICS, priorPole } from '../data/factions';
import { getTraitsByPlayer } from './agentTraits';

// Terrarium v1.5 — the relationship graph + reputation. Directed edges (how `from` feels about
// `to`) are nudged whenever a conversation ends; reputation is derived from inbound edges.
// A good conversation also lifts both people's social bar (see agentVitals). See schema.ts.

const NEUTRAL = 50;
const FAMILIARITY_GAIN = 8; // per conversation, both directions
const DELTA_SCALE = 4; // assessment ints (-3..3) -> edge points
const CLOSE_THRESHOLD = 70; // affinity at/above this reads as "close"
const DISTANT_THRESHOLD = 30; // affinity below this reads as "on the outs"

const clamp = (n: number) => Math.max(0, Math.min(100, n));

function baseEdge() {
  return { familiarity: 0, affinity: NEUTRAL, respect: NEUTRAL, trust: NEUTRAL, romantic: 0 };
}

async function bumpSocial(ctx: any, worldId: string, pid: string, delta: number) {
  const row = await ctx.db
    .query('agentVitals')
    .withIndex('playerId', (q: any) => q.eq('worldId', worldId).eq('playerId', pid))
    .first();
  if (row) {
    await ctx.db.patch(row._id, { social: clamp((row.social ?? 60) + delta) });
  } else {
    await ctx.db.insert('agentVitals', {
      worldId,
      playerId: pid,
      energy: 100,
      asleep: false,
      lastConsolidatedDay: 0,
      social: clamp(60 + delta),
    });
  }
}

async function upsertEdge(
  ctx: any,
  worldId: string,
  from: string,
  to: string,
  d: { warmth: number; respect: number; trust: number },
  now: number,
): Promise<{ affinityBefore: number; affinityAfter: number }> {
  const existing = await ctx.db
    .query('relationships')
    .withIndex('edge', (q: any) =>
      q.eq('worldId', worldId).eq('fromPlayerId', from).eq('toPlayerId', to),
    )
    .first();
  const cur = existing ?? baseEdge();
  const affinityBefore = cur.affinity;
  const next = {
    familiarity: clamp(cur.familiarity + FAMILIARITY_GAIN),
    affinity: clamp(cur.affinity + d.warmth * DELTA_SCALE),
    respect: clamp(cur.respect + d.respect * DELTA_SCALE),
    trust: clamp(cur.trust + d.trust * DELTA_SCALE),
    // A faint pull toward romance only when there's real warmth on top of existing closeness.
    romantic: clamp(cur.romantic + (d.warmth >= 2 && cur.affinity > 65 ? 3 : 0)),
    updatedAt: now,
  };
  if (existing) {
    await ctx.db.patch(existing._id, next);
  } else {
    await ctx.db.insert('relationships', { worldId, fromPlayerId: from, toPlayerId: to, ...next });
  }
  return { affinityBefore, affinityAfter: next.affinity };
}

// Apply the outcome of a finished conversation: nudge both directed edges, lift both social
// bars, and log to the Chronicle when a relationship crosses into "close" or "distant".
export const applyConversationOutcome = internalMutation({
  args: {
    worldId: v.id('worlds'),
    aPlayerId: playerId,
    aName: v.string(),
    bPlayerId: playerId,
    bName: v.string(),
    warmth: v.number(), // -3..3
    respect: v.number(), // -3..3
    trust: v.number(), // -3..3
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const d = { warmth: args.warmth, respect: args.respect, trust: args.trust };
    const ab = await upsertEdge(ctx, args.worldId, args.aPlayerId, args.bPlayerId, d, now);
    await upsertEdge(ctx, args.worldId, args.bPlayerId, args.aPlayerId, d, now);

    // Social: having a conversation is connection; a warm one lifts more, a cold one can sting.
    const socialDelta = 4 + args.warmth * 2;
    await bumpSocial(ctx, args.worldId, args.aPlayerId, socialDelta);
    await bumpSocial(ctx, args.worldId, args.bPlayerId, socialDelta);

    // Chronicle a relationship shift on a threshold crossing (using the a->b edge to fire once).
    // The label is respect-aware so it can't contradict the conversation gist: warmth and respect
    // move independently (a respectful disagreement cools warmth while raising respect), so a bald
    // "Things cooled" alongside a "grew in mutual respect" gist reads as a contradiction even though
    // both are true. Fold the respect direction into the headline.
    let summary: string | null = null;
    if (ab.affinityBefore < CLOSE_THRESHOLD && ab.affinityAfter >= CLOSE_THRESHOLD) {
      summary =
        args.respect < 0
          ? `${args.aName} and ${args.bName} grew closer, even as some respect frayed.`
          : `${args.aName} and ${args.bName} grew close.`;
    } else if (ab.affinityBefore >= DISTANT_THRESHOLD && ab.affinityAfter < DISTANT_THRESHOLD) {
      summary =
        args.respect > 0
          ? `${args.aName} and ${args.bName} drifted a little cooler — but with more respect for each other.`
          : `Things cooled between ${args.aName} and ${args.bName}.`;
    }
    if (summary) {
      await ctx.db.insert('townEvents', {
        worldId: args.worldId,
        ts: now,
        kind: 'relationship',
        playerName: args.aName,
        subjectName: args.bName,
        emoji: '💞',
        summary,
      });
    }
  },
});

// v1.8 — nudge a single directed edge (from -> to) without the full two-way conversation
// machinery. Used when someone reacts to another's work: it changes how the READER feels about
// the AUTHOR (warmth/respect), with only a small familiarity bump. Logs a threshold crossing.
export const nudgeDirected = internalMutation({
  args: {
    worldId: v.id('worlds'),
    fromPlayerId: playerId,
    fromName: v.string(),
    toPlayerId: playerId,
    toName: v.string(),
    warmth: v.number(), // -3..3
    respect: v.number(), // -3..3
  },
  handler: async (ctx, args) => {
    if (!args.warmth && !args.respect) return;
    const now = Date.now();
    const existing = await ctx.db
      .query('relationships')
      .withIndex('edge', (q: any) =>
        q
          .eq('worldId', args.worldId)
          .eq('fromPlayerId', args.fromPlayerId)
          .eq('toPlayerId', args.toPlayerId),
      )
      .first();
    const cur = existing ?? baseEdge();
    const affinityBefore = cur.affinity;
    const next = {
      familiarity: clamp(cur.familiarity + 2),
      affinity: clamp(cur.affinity + args.warmth * DELTA_SCALE),
      respect: clamp(cur.respect + args.respect * DELTA_SCALE),
      trust: cur.trust,
      romantic: cur.romantic,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, next);
    else
      await ctx.db.insert('relationships', {
        worldId: args.worldId,
        fromPlayerId: args.fromPlayerId,
        toPlayerId: args.toPlayerId,
        ...next,
      });
    let summary: string | null = null;
    if (affinityBefore < CLOSE_THRESHOLD && next.affinity >= CLOSE_THRESHOLD) {
      summary = `${args.fromName} warmed to ${args.toName} over their work.`;
    } else if (affinityBefore >= DISTANT_THRESHOLD && next.affinity < DISTANT_THRESHOLD) {
      summary = `${args.fromName} cooled on ${args.toName} over their work.`;
    }
    if (summary) {
      await ctx.db.insert('townEvents', {
        worldId: args.worldId,
        ts: now,
        kind: 'relationship',
        playerName: args.fromName,
        subjectName: args.toName,
        emoji: '💞',
        summary,
      });
    }
  },
});

// v2.8 — how THIS speaker feels about the person in front of them, for the dialogue prompt. Without
// this the agent talks to everyone blind to its own affinity/respect/trust → uniform niceness.
export const edgeFor = internalQuery({
  args: { worldId: v.id('worlds'), fromPlayerId: playerId, toPlayerId: playerId },
  handler: async (ctx, args) => {
    const e = await ctx.db
      .query('relationships')
      .withIndex('edge', (q: any) =>
        q
          .eq('worldId', args.worldId)
          .eq('fromPlayerId', args.fromPlayerId)
          .eq('toPlayerId', args.toPlayerId),
      )
      .first();
    if (!e) return null;
    return { familiarity: e.familiarity, affinity: e.affinity, respect: e.respect, trust: e.trust };
  },
});

// v2.8 (Tier B) — seed the social graph from BELIEF DISTANCE so the town doesn't start (or, run on a
// live world, RESET to) uniform neutral-warm. For each ordered pair we score agreement across the
// charged fault lines (same pole = +1, opposite = -1) and offset the opening edge: people who clash
// on convictions start cool, people who align start warm. Affinity moves most (you like people who
// see the world like you); respect/trust move less (you can respect someone you disagree with). Kept
// in a civil band — real friction, not enemies. OVERWRITES existing edges, so it's a deliberate
// reset of the relationship graph; run it once when you want to re-establish realistic starting
// friction. Familiarity is seeded modestly (they already know each other in this small town).
export const seedBeliefBasedRelationships = internalMutation({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const cast = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q: any) => q.eq('worldId', args.worldId))
      .collect();
    const now = Date.now();
    const traitsByPlayer = await getTraitsByPlayer(ctx, args.worldId);
    let seeded = 0;
    for (const a of cast) {
      for (const b of cast) {
        if (a.playerId === b.playerId) continue;
        // Net alignment over the topics they BOTH hold a position on.
        let net = 0;
        for (const t of CHARGED_TOPICS) {
          const pa = priorPole(a.name, t, traitsByPlayer.get(String(a.playerId)));
          const pb = priorPole(b.name, t, traitsByPlayer.get(String(b.playerId)));
          if (pa == null || pb == null) continue;
          net += pa === pb ? 1 : -1;
        }
        const affinity = clamp(NEUTRAL + net * 7); // ±7 per topic → 3-topic clash ≈ 29, full align ≈ 71
        const respect = clamp(NEUTRAL + net * 3); // you can respect an opponent — smaller swing
        const trust = clamp(NEUTRAL + net * 3);
        const existing = await ctx.db
          .query('relationships')
          .withIndex('edge', (q: any) =>
            q
              .eq('worldId', args.worldId)
              .eq('fromPlayerId', a.playerId)
              .eq('toPlayerId', b.playerId),
          )
          .first();
        const next = { familiarity: 25, affinity, respect, trust, romantic: 0, updatedAt: now };
        if (existing) await ctx.db.patch(existing._id, next);
        else
          await ctx.db.insert('relationships', {
            worldId: args.worldId,
            fromPlayerId: a.playerId,
            toPlayerId: b.playerId,
            ...next,
          });
        seeded++;
      }
    }
    return { seeded };
  },
});

// A player's outgoing relationships (how they feel about everyone), strongest first.
export const getRelationships = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const edges = await ctx.db
      .query('relationships')
      .withIndex('outbound', (q) => q.eq('worldId', args.worldId).eq('fromPlayerId', args.playerId))
      .collect();
    return edges
      .map((e) => ({
        toPlayerId: e.toPlayerId,
        familiarity: e.familiarity,
        affinity: e.affinity,
        respect: e.respect,
        trust: e.trust,
        romantic: e.romantic,
      }))
      .sort((a, b) => b.familiarity - a.familiarity);
  },
});

// Town-wide standing: each player's reputation = how others feel about them (inbound affinity +
// respect, above neutral). A simple aggregate over the relationship graph.
export const listReputation = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const edges = await ctx.db
      .query('relationships')
      .withIndex('inbound', (q) => q.eq('worldId', args.worldId))
      .collect();
    const score = new Map<string, number>();
    for (const e of edges) {
      const prev = score.get(e.toPlayerId) ?? 0;
      score.set(e.toPlayerId, prev + (e.affinity - NEUTRAL) + (e.respect - NEUTRAL));
    }
    // v1.9 — chronically flaking at work costs you standing: subtract the work penalty.
    const work = await ctx.db
      .query('workState')
      .withIndex('author', (q) => q.eq('worldId', args.worldId))
      .collect();
    for (const w of work) {
      if (w.standingPenalty) score.set(w.playerId, (score.get(w.playerId) ?? 0) - w.standingPenalty);
    }
    return [...score.entries()].map(([pid, prestige]) => ({ playerId: pid, prestige }));
  },
});
