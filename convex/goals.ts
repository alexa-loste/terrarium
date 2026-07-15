import { v } from 'convex/values';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import { playerId } from './aiTown/ids';
import { driveSeedFor } from '../data/drives';

// v2.1 — goal storage. One long-term aspiration per character + a rolling set of short-term
// milestones beneath it. The LLM (composeGoalReview, nightly) decides what's done and what the
// next milestones are; this module is the durable store + the deadline bookkeeping that feeds
// mood. Keeping it structured (not just in memory) is what makes a missed deadline actually bite.

const MAX_ACTIVE_SHORT = 3;

// Seed each character's long-term aspiration from their drive profile. Idempotent. Run after
// deploy: convex run goals:seedWorld '{"worldId":"...","startDay":1}'.
export const seedWorld = mutation({
  args: { worldId: v.id('worlds'), startDay: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const startDay = args.startDay ?? 1;
    const descriptions = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    let seeded = 0;
    for (const d of descriptions) {
      const seed = driveSeedFor(d.name);
      if (!seed) continue;
      const existingLong = (
        await ctx.db
          .query('goals')
          .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', d.playerId))
          .collect()
      ).find((g) => g.tier === 'long');
      if (existingLong) continue;
      await ctx.db.insert('goals', {
        worldId: args.worldId,
        playerId: d.playerId,
        playerName: d.name,
        tier: 'long',
        text: seed.aspiration,
        createdDay: startDay,
        dueDay: startDay + seed.horizonDays,
        status: 'active',
        updatedAt: Date.now(),
      });
      seeded++;
    }
    return { seeded };
  },
});

async function activeShort(ctx: any, worldId: string, pid: string) {
  const rows = await ctx.db
    .query('goals')
    .withIndex('author', (q: any) => q.eq('worldId', worldId).eq('playerId', pid))
    .collect();
  return rows.filter((g: any) => g.tier === 'short' && g.status === 'active');
}

// Add a short-term milestone (capped so the list stays focused).
export const addShort = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    playerName: v.string(),
    text: v.string(),
    dueDay: v.number(),
    currentDay: v.number(),
  },
  handler: async (ctx, args) => {
    const active = await activeShort(ctx, args.worldId, args.playerId);
    if (active.length >= MAX_ACTIVE_SHORT) return null;
    return await ctx.db.insert('goals', {
      worldId: args.worldId,
      playerId: args.playerId,
      playerName: args.playerName,
      tier: 'short',
      text: args.text.slice(0, 160),
      createdDay: args.currentDay,
      dueDay: args.dueDay,
      status: 'active',
      updatedAt: Date.now(),
    });
  },
});

// Mark a goal done/missed with a note. Used by the nightly review (by index into active shorts).
export const markGoal = internalMutation({
  args: {
    goalId: v.id('goals'),
    status: v.union(v.literal('done'), v.literal('missed')),
    note: v.optional(v.string()),
    day: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.goalId, {
      status: args.status,
      note: args.note?.slice(0, 200),
      resolvedDay: args.day,
      updatedAt: Date.now(),
    });
  },
});

// v2.9 — record a day of real effort spent on a short goal (from maybeWorkOnGoal). Bumps the
// progress counter + stamps the day, so the nightly review can credit goals that were actually
// worked and a goal is worked at most once per day. No-op if the goal isn't active.
export const recordProgress = internalMutation({
  args: { goalId: v.id('goals'), day: v.number() },
  handler: async (ctx, args) => {
    const g = await ctx.db.get(args.goalId);
    if (!g || g.status !== 'active') return null;
    await ctx.db.patch(args.goalId, {
      progressDays: (g.progressDays ?? 0) + 1,
      lastProgressDay: args.day,
      updatedAt: Date.now(),
    });
    return null;
  },
});

// Past-due active short goals become 'missed' (a deadline blown). Returns the missed texts so the
// caller can stress + journal about them.
export const sweepOverdue = internalMutation({
  args: { worldId: v.id('worlds'), playerId, currentDay: v.number() },
  handler: async (ctx, args): Promise<{ missed: string[] }> => {
    const active = await activeShort(ctx, args.worldId, args.playerId);
    const missed: string[] = [];
    for (const g of active) {
      if (args.currentDay > g.dueDay) {
        await ctx.db.patch(g._id, {
          status: 'missed',
          resolvedDay: args.currentDay,
          updatedAt: Date.now(),
        });
        missed.push(g.text);
      }
    }
    return { missed };
  },
});

// Internal: the live goal picture for prompts + mood. Long-term + active shorts (with days-left),
// plus recent wins/losses (last 2 days) that momentum keys off.
export const activeForPlayer = internalQuery({
  args: { worldId: v.id('worlds'), playerId, currentDay: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('goals')
      .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .collect();
    const long = rows.find((g) => g.tier === 'long' && g.status === 'active') ?? null;
    const shorts = rows
      .filter((g) => g.tier === 'short' && g.status === 'active')
      .sort((a, b) => a.dueDay - b.dueDay)
      .map((g) => ({
        id: g._id,
        text: g.text,
        dueDay: g.dueDay,
        daysLeft: g.dueDay - args.currentDay,
        progressDays: g.progressDays ?? 0,
        lastProgressDay: g.lastProgressDay ?? null,
      }));
    const recentDone = rows.filter(
      (g) => g.status === 'done' && (g.resolvedDay ?? -99) >= args.currentDay - 2,
    ).length;
    const recentMissed = rows.filter(
      (g) => g.status === 'missed' && (g.resolvedDay ?? -99) >= args.currentDay - 2,
    ).length;
    const overdueSoon = shorts.filter((s) => s.daysLeft <= 0).length;
    return {
      long: long ? { text: long.text, dueDay: long.dueDay } : null,
      shorts,
      recentDone,
      recentMissed,
      overdueSoon,
    };
  },
});

// For the UI panel: every goal, long first then shorts by due date, active before resolved.
export const getForPlayer = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('goals')
      .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .collect();
    const rank = (s: string) => (s === 'active' ? 0 : 1);
    return rows.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier === 'long' ? -1 : 1;
      if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
      return a.dueDay - b.dueDay;
    });
  },
});
