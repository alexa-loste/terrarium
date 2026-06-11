import { v } from 'convex/values';
import { mutation, query, internalQuery } from './_generated/server';
import { WorldClock, worldTime, SPEED_OPTIONS, WORLD_DAY_MS } from '../data/clock';

// Terrarium v1.3 — the anchored world clock (see data/clock.ts for the time math).
//
// One small singleton row per world holds the anchor (epochRealMs, epochWorldMs, speed).
// Changing speed re-anchors so the on-screen time never jumps. The engine tick is NOT
// touched — world-time is derived on read, keeping the hot path untouched.

// epochWorldMs is in WORLD-ms, where a full day spans WORLD_DAY_MS. Start at 08:00 on Day 1.
const DEFAULT_CLOCK = (now: number): WorldClock => ({
  epochRealMs: now,
  epochWorldMs: (8 / 24) * WORLD_DAY_MS, // 08:00, Day 1 (morning)
  speed: 1,
});

async function readClock(ctx: any, worldId: string): Promise<WorldClock> {
  const row = await ctx.db
    .query('worldClock')
    .withIndex('worldId', (q: any) => q.eq('worldId', worldId))
    .first();
  if (row) {
    return { epochRealMs: row.epochRealMs, epochWorldMs: row.epochWorldMs, speed: row.speed };
  }
  return DEFAULT_CLOCK(Date.now());
}

// Pin a Day-1 08:00 anchor the first time the world runs. Idempotent: a no-op once a row
// exists, so freeze/resume cycles don't reset the day. Called from testing:resume.
export async function ensureClockRow(ctx: any, worldId: string): Promise<void> {
  const existing = await ctx.db
    .query('worldClock')
    .withIndex('worldId', (q: any) => q.eq('worldId', worldId))
    .first();
  if (existing) return;
  await ctx.db.insert('worldClock', { worldId, ...DEFAULT_CLOCK(Date.now()) });
}

// Current clock + the world time it implies right now. Read by the frontend and by agents.
export const getClock = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const clock = await readClock(ctx, args.worldId);
    const now = Date.now();
    return { ...clock, now, time: worldTime(clock, now) };
  },
});

// Same data, callable from agent actions deciding where to go / what to say.
export const currentTime = internalQuery({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const clock = await readClock(ctx, args.worldId);
    const now = Date.now();
    return { ...worldTime(clock, now), speed: clock.speed };
  },
});

// Change how fast world-time advances, re-anchoring so the displayed time is continuous.
export const setSpeed = mutation({
  args: { worldId: v.id('worlds'), speed: v.number() },
  handler: async (ctx, args) => {
    if (!SPEED_OPTIONS.includes(args.speed as any)) {
      throw new Error(`Unsupported speed ${args.speed}`);
    }
    const now = Date.now();
    const existing = await ctx.db
      .query('worldClock')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .unique();
    const current = existing
      ? { epochRealMs: existing.epochRealMs, epochWorldMs: existing.epochWorldMs, speed: existing.speed }
      : DEFAULT_CLOCK(now);
    // Re-anchor at the current world position, then switch speed.
    const epochWorldMs = current.epochWorldMs + (now - current.epochRealMs) * current.speed;
    const next = { worldId: args.worldId, epochRealMs: now, epochWorldMs, speed: args.speed };
    if (existing) {
      await ctx.db.patch(existing._id, next);
    } else {
      await ctx.db.insert('worldClock', next);
    }
    return args.speed;
  },
});
