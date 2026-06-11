import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';
import { playerId } from './aiTown/ids';
import {
  jobFor,
  MISSED_SHIFT_MONEY,
  MISSED_DELIVERABLE_MONEY,
  MISSED_SHIFT_STANDING,
  MISSED_DELIVERABLE_STANDING,
  STANDING_RECOVERY_PER_DAY,
} from '../data/work';

// v1.9 — work obligation state + the daily evaluation that applies the stakes.

async function loadOrInit(ctx: any, worldId: string, pid: string, playerName: string, day: number) {
  const existing = await ctx.db
    .query('workState')
    .withIndex('author', (q: any) => q.eq('worldId', worldId).eq('playerId', pid))
    .first();
  if (existing) return existing;
  const id = await ctx.db.insert('workState', {
    worldId,
    playerId: pid,
    playerName,
    lastEvalDay: day,
    attendedToday: false,
    cycleStartDay: day,
    deliverablesThisCycle: 0,
    behind: false,
    standingPenalty: 0,
    missedCount: 0,
  });
  return await ctx.db.get(id);
}

// Mark a scheduled worker as having shown up to their shift today.
export const markAttended = internalMutation({
  args: { worldId: v.id('worlds'), playerId, playerName: v.string(), day: v.number() },
  handler: async (ctx, args) => {
    const ws = await loadOrInit(ctx, args.worldId, args.playerId, args.playerName, args.day);
    if (!ws.attendedToday) await ctx.db.patch(ws._id, { attendedToday: true });
  },
});

// Count a shipped deliverable toward the current cycle (called when an artifact is made).
export const recordDeliverable = internalMutation({
  args: { worldId: v.id('worlds'), playerId, playerName: v.string(), day: v.number() },
  handler: async (ctx, args) => {
    const ws = await loadOrInit(ctx, args.worldId, args.playerId, args.playerName, args.day);
    const next = ws.deliverablesThisCycle + 1;
    const patch: any = { deliverablesThisCycle: next };
    // Hitting quota mid-cycle clears the "behind" pressure right away.
    const job = jobFor(args.playerName);
    if (job.kind === 'deliverable' && next >= job.quota && ws.behind) patch.behind = false;
    await ctx.db.patch(ws._id, patch);
  },
});

// The once-a-day reckoning: did they meet their obligation? Applies money + standing + the
// `behind` flag (which drives stress), and decays the standing penalty as they recover. Returns
// whether they're behind and a one-line stress message for the journal (or null).
export const evaluate = internalMutation({
  args: { worldId: v.id('worlds'), playerId, playerName: v.string(), day: v.number() },
  handler: async (ctx, args): Promise<{ behind: boolean; message: string | null }> => {
    const ws = await loadOrInit(ctx, args.worldId, args.playerId, args.playerName, args.day);
    // Evaluate once per day. (A freshly-created row is stamped with today, so day 1 is a freebie.)
    if (ws.lastEvalDay === args.day) {
      return { behind: ws.behind, message: null };
    }
    const job = jobFor(args.playerName);
    let moneyPenalty = 0;
    let standingAdd = 0;
    let behind = false;
    let message: string | null = null;
    const patch: any = { lastEvalDay: args.day };

    if (job.kind === 'scheduled') {
      if (!ws.attendedToday) {
        moneyPenalty = MISSED_SHIFT_MONEY;
        standingAdd = MISSED_SHIFT_STANDING;
        behind = true;
        patch.missedCount = ws.missedCount + 1;
        message = 'you skipped your shift today, and it is starting to catch up with you';
      }
      patch.attendedToday = false; // reset for the new day
    } else {
      // deliverable: only reckon when a cycle closes
      if (args.day - ws.cycleStartDay >= job.perDays) {
        const shortfall = Math.max(0, job.quota - ws.deliverablesThisCycle);
        if (shortfall > 0) {
          moneyPenalty = shortfall * MISSED_DELIVERABLE_MONEY;
          standingAdd = shortfall * MISSED_DELIVERABLE_STANDING;
          behind = true;
          patch.missedCount = ws.missedCount + 1;
          message = `you missed your deadline — only ${ws.deliverablesThisCycle} of ${job.quota} pieces shipped this cycle`;
        }
        patch.cycleStartDay = args.day;
        patch.deliverablesThisCycle = 0;
      } else {
        behind = ws.behind; // mid-cycle: carry the current state
      }
    }
    patch.behind = behind;
    patch.standingPenalty = Math.max(0, ws.standingPenalty + standingAdd - STANDING_RECOVERY_PER_DAY);
    await ctx.db.patch(ws._id, patch);

    // Apply the money hit to their wallet.
    if (moneyPenalty > 0) {
      const vit = await ctx.db
        .query('agentVitals')
        .withIndex('playerId', (q: any) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
        .first();
      if (vit) await ctx.db.patch(vit._id, { money: Math.max(0, (vit.money ?? 0) - moneyPenalty) });
    }
    return { behind, message };
  },
});

// For the UI: a player's work standing.
export const getForPlayer = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const ws = await ctx.db
      .query('workState')
      .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    if (!ws) return null;
    const job = jobFor(ws.playerName);
    return {
      behind: ws.behind,
      standingPenalty: ws.standingPenalty,
      missedCount: ws.missedCount,
      deliverablesThisCycle: ws.deliverablesThisCycle,
      quota: job.kind === 'deliverable' ? job.quota : null,
    };
  },
});
