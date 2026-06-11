import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';
import { playerId } from './aiTown/ids';

// v1.7 — the per-character journal. Written by convex/agent/journal.ts:writeJournalEntry; read
// here for the player panel. Private to each character (the observer can read it, the other
// agents cannot).

const triggerValidator = v.union(
  v.literal('reflection'),
  v.literal('conversation'),
  v.literal('artifact'),
  v.literal('event'),
  v.literal('spontaneous'),
);

export const addEntry = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    playerName: v.string(),
    trigger: triggerValidator,
    contextNote: v.optional(v.string()),
    text: v.string(),
    day: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('journalEntries', { ...args, createdAt: Date.now() });
  },
});

// One character's journal, newest first.
export const listByAuthor = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('journalEntries')
      .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .order('desc')
      .take(50);
  },
});
