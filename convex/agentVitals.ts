import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from './_generated/server';
import { playerId } from './aiTown/ids';
import { MAX_FOOD, STARTING_MONEY } from '../data/economy';

// Terrarium v1.3/v1.4 — per-agent vitals + economy. Energy drains while awake and recharges
// by sleeping (with one overnight consolidation). Food drains while awake and refills by
// eating (costs money). Money is earned by working. Read by the UI; written from agentOperations.

export const MAX_ENERGY = 100;

export const getVitals = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('agentVitals')
      .withIndex('playerId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
  },
});

export const setVitals = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    energy: v.optional(v.number()),
    asleep: v.optional(v.boolean()),
    lastConsolidatedDay: v.optional(v.number()),
    food: v.optional(v.number()),
    money: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { worldId, playerId: pid, ...patch } = args;
    const existing = await ctx.db
      .query('agentVitals')
      .withIndex('playerId', (q) => q.eq('worldId', worldId).eq('playerId', pid))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert('agentVitals', {
        worldId,
        playerId: pid,
        energy: patch.energy ?? MAX_ENERGY,
        asleep: patch.asleep ?? false,
        lastConsolidatedDay: patch.lastConsolidatedDay ?? 0,
        food: patch.food ?? MAX_FOOD,
        money: patch.money ?? STARTING_MONEY,
      });
    }
  },
});

// All agents' vitals for the world, for the roster display.
export const listVitals = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('agentVitals')
      .withIndex('playerId', (q) => q.eq('worldId', args.worldId))
      .collect();
    return rows.map((r) => ({
      playerId: r.playerId,
      energy: r.energy,
      asleep: r.asleep,
      food: r.food ?? MAX_FOOD,
      money: r.money ?? STARTING_MONEY,
    }));
  },
});
