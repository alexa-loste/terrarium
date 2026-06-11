import { v } from 'convex/values';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import { playerId } from './aiTown/ids';
import { seedBeliefsFor } from '../data/beliefs';

// v1.8 — belief storage + seeding + evolution.

const CONVICTION_MIN = 0;
const CONVICTION_MAX = 100;
const clamp = (n: number) => Math.max(CONVICTION_MIN, Math.min(CONVICTION_MAX, n));
// A conviction move of this size or more counts as a real "shift" (marked in the UI + logged).
export const SHIFT_THRESHOLD = 6;

// Seed every character's beliefs from their profile, once. Idempotent: a player who already has
// beliefs is skipped. Run after deploy (convex run beliefs:seedWorld '{"worldId":"..."}') and
// it's also safe to re-run.
export const seedWorld = mutation({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const descriptions = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    let seeded = 0;
    for (const d of descriptions) {
      const existing = await ctx.db
        .query('beliefs')
        .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', d.playerId))
        .first();
      if (existing) continue;
      // SEED_BELIEFS is keyed by display name ("Priya"), not the sprite id in d.character.
      const seeds = seedBeliefsFor(d.name);
      for (const s of seeds) {
        await ctx.db.insert('beliefs', {
          worldId: args.worldId,
          playerId: d.playerId,
          playerName: d.name,
          topic: s.topic,
          statement: s.statement,
          conviction: clamp(s.conviction),
          origin: 'seed',
          updatedAt: Date.now(),
        });
        seeded++;
      }
    }
    return { seeded };
  },
});

// A player's beliefs, strongest first — for the UI and the prompt context.
export const getForPlayer = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('beliefs')
      .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .collect();
    return rows.sort((a, b) => b.conviction - a.conviction);
  },
});

// Same, but internal — handed into LLM prompts (compose/converse/react).
export const forContext = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('beliefs')
      .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .collect();
    return rows
      .sort((a, b) => b.conviction - a.conviction)
      .map((r) => ({ topic: r.topic, statement: r.statement, conviction: r.conviction }));
  },
});

// Move one belief's conviction by `delta` (signed). Matches on topic (case-insensitive); if no
// topic matches, the nearest by substring is used, else it's a no-op. Marks a shift when big.
export const nudgeBelief = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    topic: v.string(),
    delta: v.number(),
    // Optional rewritten statement, when the reaction reframed how they hold the belief.
    statement: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.delta && !args.statement) return null;
    const rows = await ctx.db
      .query('beliefs')
      .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .collect();
    const t = args.topic.toLowerCase().trim();
    let target =
      rows.find((r) => r.topic.toLowerCase() === t) ??
      rows.find((r) => r.topic.toLowerCase().includes(t) || t.includes(r.topic.toLowerCase()));
    if (!target) return null;
    const next = clamp(target.conviction + args.delta);
    const patch: any = { conviction: next, updatedAt: Date.now() };
    if (Math.abs(next - target.conviction) >= SHIFT_THRESHOLD) patch.lastShiftAt = Date.now();
    if (args.statement) patch.statement = args.statement.slice(0, 240);
    await ctx.db.patch(target._id, patch);
    return { topic: target.topic, from: target.conviction, to: next };
  },
});

// Add a newly-formed conviction (e.g. a strong reaction crystallized into a new belief).
export const addBelief = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    playerName: v.string(),
    topic: v.string(),
    statement: v.string(),
    conviction: v.number(),
  },
  handler: async (ctx, args) => {
    // Don't duplicate an existing topic.
    const rows = await ctx.db
      .query('beliefs')
      .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .collect();
    if (rows.some((r) => r.topic.toLowerCase() === args.topic.toLowerCase())) return null;
    return await ctx.db.insert('beliefs', {
      worldId: args.worldId,
      playerId: args.playerId,
      playerName: args.playerName,
      topic: args.topic.slice(0, 40),
      statement: args.statement.slice(0, 240),
      conviction: clamp(args.conviction),
      origin: 'evolved',
      updatedAt: Date.now(),
      lastShiftAt: Date.now(),
    });
  },
});

// Apply the overnight drift: a set of {topic, delta} nudges from the nightly review.
export const applyDrift = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    drifts: v.array(v.object({ topic: v.string(), delta: v.number() })),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('beliefs')
      .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .collect();
    for (const d of args.drifts) {
      const t = d.topic.toLowerCase().trim();
      const target =
        rows.find((r) => r.topic.toLowerCase() === t) ??
        rows.find((r) => r.topic.toLowerCase().includes(t) || t.includes(r.topic.toLowerCase()));
      if (!target) continue;
      const next = clamp(target.conviction + d.delta);
      const patch: any = { conviction: next, updatedAt: Date.now() };
      if (Math.abs(next - target.conviction) >= SHIFT_THRESHOLD) patch.lastShiftAt = Date.now();
      await ctx.db.patch(target._id, patch);
    }
  },
});
