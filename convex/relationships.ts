import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';
import { playerId } from './aiTown/ids';

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
    let summary: string | null = null;
    if (ab.affinityBefore < CLOSE_THRESHOLD && ab.affinityAfter >= CLOSE_THRESHOLD) {
      summary = `${args.aName} and ${args.bName} grew close.`;
    } else if (ab.affinityBefore >= DISTANT_THRESHOLD && ab.affinityAfter < DISTANT_THRESHOLD) {
      summary = `Things cooled between ${args.aName} and ${args.bName}.`;
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
    return [...score.entries()].map(([pid, prestige]) => ({ playerId: pid, prestige }));
  },
});
