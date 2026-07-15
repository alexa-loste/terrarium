import { v } from 'convex/values';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import { playerId } from './aiTown/ids';
import { MAX_FOOD, STARTING_MONEY, realisticWealthFor } from '../data/economy';
import { reconcileNightSpeed } from './clock';

// Terrarium v1.3/v1.4 — per-agent vitals + economy. Energy drains while awake and recharges
// by sleeping (with one overnight consolidation). Food drains while awake and refills by
// eating (costs money). Money is earned by working. Read by the UI; written from agentOperations.

export const MAX_ENERGY = 100;
export const START_SOCIAL = 60;
export const START_LEISURE = 60; // v2.1 — fun / rest need
export const START_STRESS = 25; // v2.1 — derived weather, seeded calm-ish
export const START_MOMENTUM = 50; // v2.1 — 50 = neutral orientation

// v2.5 — re-seed everyone's liquid savings to a realistic, career-tiered net worth (data/economy.ts
// REALISTIC_WEALTH). One-off: run once to reset the noisy wealth picture; from then on the daily
// settlement keeps the disparity propagating. Creates a vitals row if one is somehow missing.
export const seedRealisticWealth = mutation({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const descriptions = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    const out: { name: string; money: number }[] = [];
    for (const d of descriptions) {
      const money = realisticWealthFor(d.name);
      const vit = await ctx.db
        .query('agentVitals')
        .withIndex('playerId', (q) => q.eq('worldId', args.worldId).eq('playerId', d.playerId))
        .first();
      if (vit) await ctx.db.patch(vit._id, { money });
      out.push({ name: d.name, money });
    }
    return out.sort((a, b) => b.money - a.money);
  },
});

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
    social: v.optional(v.number()),
    leisure: v.optional(v.number()),
    stress: v.optional(v.number()),
    momentum: v.optional(v.number()),
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
        social: patch.social ?? START_SOCIAL,
        leisure: patch.leisure ?? START_LEISURE,
        stress: patch.stress ?? START_STRESS,
        momentum: patch.momentum ?? START_MOMENTUM,
      });
    }
    // v2.10 — when this write flips a sleep/wake state, reconcile the night fast-forward (8x while
    // all asleep, 1x the moment anyone is up). Only on asleep-touching writes, so normal vitals
    // patches stay cheap.
    if (patch.asleep !== undefined) {
      await reconcileNightSpeed(ctx, worldId);
    }
  },
});

// Add to (or subtract from) a player's wallet without needing to know the current balance —
// used when shipping a deliverable pays out (v1.9). Floors at 0.
export const addMoney = internalMutation({
  args: { worldId: v.id('worlds'), playerId, amount: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('agentVitals')
      .withIndex('playerId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        money: Math.max(0, (existing.money ?? STARTING_MONEY) + args.amount),
      });
    } else {
      await ctx.db.insert('agentVitals', {
        worldId: args.worldId,
        playerId: args.playerId,
        energy: MAX_ENERGY,
        asleep: false,
        lastConsolidatedDay: 0,
        food: MAX_FOOD,
        money: Math.max(0, STARTING_MONEY + args.amount),
        social: START_SOCIAL,
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
      social: r.social ?? START_SOCIAL,
      leisure: r.leisure ?? START_LEISURE,
      stress: r.stress ?? START_STRESS,
      momentum: r.momentum ?? START_MOMENTUM,
    }));
  },
});
