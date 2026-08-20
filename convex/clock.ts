import { v } from 'convex/values';
import { mutation, query, internalQuery } from './_generated/server';
import { WorldClock, WorldTime, worldTime, SPEED_OPTIONS, WORLD_DAY_MS } from '../data/clock';

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

type StoredClock = WorldClock & { frozen: boolean };

async function readClock(ctx: any, worldId: string): Promise<StoredClock> {
  const row = await ctx.db
    .query('worldClock')
    .withIndex('worldId', (q: any) => q.eq('worldId', worldId))
    .first();
  if (row) {
    return {
      epochRealMs: row.epochRealMs,
      epochWorldMs: row.epochWorldMs,
      speed: row.speed,
      frozen: !!row.frozen,
    };
  }
  return { ...DEFAULT_CLOCK(Date.now()), frozen: false };
}

// While frozen, world-time stands still at the anchor — speed 0 makes worldTime() ignore
// elapsed real time. Used by both getClock and currentTime, and mirrored on the frontend.
function effective(clock: StoredClock): WorldClock {
  return clock.frozen ? { ...clock, speed: 0 } : clock;
}

// Pin a Day-1 08:00 anchor the first time the world runs. Idempotent: a no-op once a row
// exists, so freeze/resume cycles don't reset the day. Called from testing:resume.
export async function ensureClockRow(ctx: any, worldId: string): Promise<void> {
  const existing = await ctx.db
    .query('worldClock')
    .withIndex('worldId', (q: any) => q.eq('worldId', worldId))
    .first();
  if (existing) return;
  await ctx.db.insert('worldClock', { worldId, ...DEFAULT_CLOCK(Date.now()), frozen: false });
}

// Pause world-time: re-anchor at the current world position so it doesn't jump, then freeze.
// Called from testing:stop so the clock stops when the world is frozen.
export async function freezeClock(ctx: any, worldId: string): Promise<void> {
  const row = await ctx.db
    .query('worldClock')
    .withIndex('worldId', (q: any) => q.eq('worldId', worldId))
    .first();
  const now = Date.now();
  const cur = row
    ? { epochRealMs: row.epochRealMs, epochWorldMs: row.epochWorldMs, speed: row.speed }
    : DEFAULT_CLOCK(now);
  const epochWorldMs = cur.epochWorldMs + (now - cur.epochRealMs) * cur.speed;
  if (row) {
    await ctx.db.patch(row._id, { epochRealMs: now, epochWorldMs, frozen: true });
  } else {
    await ctx.db.insert('worldClock', { worldId, ...cur, epochRealMs: now, epochWorldMs, frozen: true });
  }
}

// Resume world-time from where it was frozen.
export async function unfreezeClock(ctx: any, worldId: string): Promise<void> {
  const row = await ctx.db
    .query('worldClock')
    .withIndex('worldId', (q: any) => q.eq('worldId', worldId))
    .first();
  if (!row) {
    await ctx.db.insert('worldClock', { worldId, ...DEFAULT_CLOCK(Date.now()), frozen: false });
    return;
  }
  await ctx.db.patch(row._id, { epochRealMs: Date.now(), frozen: false });
}

// v2.10 — NIGHT FAST-FORWARD. When every agent is asleep, no decisions happen — it's dead
// sim-time. So auto-jump to NIGHT_SPEED to skim through the night, and snap back to DAY_SPEED the
// instant anyone wakes. Called from agentVitals.setVitals (the chokepoint for every sleep/wake
// write), so it reconciles with zero lag on fresh state — no polling cron, no overshoot into the
// morning. Re-anchors like setSpeed so the displayed clock never jumps. Leaves a frozen world
// alone (freeze overrides speed) and no-ops when speed already matches.
// NIGHT_SPEED must stay low enough that one asleep re-decide tick (~SLEEP_DURATION=60s real) can't
// leap the whole night. Engine ticks fire on a FIXED real cadence regardless of clock speed (the
// clock is derived-on-read, hot path untouched), so at speed S one sleep tick ≈ S world-hours. The
// night window is 8 world-hours; at 8x a single tick jumps the entire night, so agents skip their
// night-phase tick → miss the overnight consolidation + energy recharge + belief drift, and the
// all-asleep state can't sustain (it instantly races to a wake). 4x ≈ 4h/tick → the night is sampled
// ~twice, consolidation fires, and it's still a real speedup. Don't raise without shortening the
// sleep re-decide cadence to match (which costs many more DB writes — bad under the Starter limit).
const NIGHT_SPEED = 4; // fast-forward the all-asleep night (capped so it can't skip the night)
const DAY_SPEED = 1; // normal speed whenever anyone is awake

export async function reconcileNightSpeed(ctx: any, worldId: string): Promise<void> {
  const clockRow = await ctx.db
    .query('worldClock')
    .withIndex('worldId', (q: any) => q.eq('worldId', worldId))
    .first();
  if (!clockRow || clockRow.frozen) return;
  const vitals = await ctx.db
    .query('agentVitals')
    .withIndex('playerId', (q: any) => q.eq('worldId', worldId))
    .collect();
  if (!vitals.length) return;
  const allAsleep = vitals.every((v: any) => v.asleep);
  const desired = allAsleep ? NIGHT_SPEED : DAY_SPEED;
  if (clockRow.speed === desired) return;
  // Re-anchor at the current world position so the displayed time is continuous, then switch.
  const now = Date.now();
  const epochWorldMs = clockRow.epochWorldMs + (now - clockRow.epochRealMs) * clockRow.speed;
  await ctx.db.patch(clockRow._id, { epochRealMs: now, epochWorldMs, speed: desired });
}

// Current clock + the world time it implies right now. Read by the frontend and by agents.
export const getClock = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const clock = await readClock(ctx, args.worldId);
    const now = Date.now();
    return { ...clock, now, time: worldTime(effective(clock), now) };
  },
});

// The world time right now, for code running inside a query or mutation (which cannot runQuery the
// internalQuery below). Same math, same frozen handling — one definition, so a caller can never
// read a different clock than the agents do.
export async function worldTimeNow(ctx: any, worldId: string): Promise<WorldTime> {
  const clock = await readClock(ctx, worldId);
  return worldTime(effective(clock), Date.now());
}

// Same data, callable from agent actions deciding where to go / what to say.
export const currentTime = internalQuery({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const clock = await readClock(ctx, args.worldId);
    const now = Date.now();
    return { ...worldTime(effective(clock), now), speed: clock.speed, frozen: clock.frozen };
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
