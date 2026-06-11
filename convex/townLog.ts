import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';
import { playerId } from './aiTown/ids';

// Terrarium v1.3 — the Town Chronicle: a readable, god-view stream of gisted events.
// Conversations, feed posts, and inner thoughts all get distilled to one line here as they
// happen, so you can follow the life of the town without reading every message. Later slices
// add relationship + artifact events to the same stream.

const eventKind = v.union(
  v.literal('thought'),
  v.literal('conversation'),
  v.literal('feed'),
  v.literal('relationship'),
  v.literal('artifact'),
  v.literal('system'),
);

export const recordEvent = internalMutation({
  args: {
    worldId: v.id('worlds'),
    kind: eventKind,
    summary: v.string(),
    playerId: v.optional(playerId),
    playerName: v.optional(v.string()),
    subjectName: v.optional(v.string()),
    emoji: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { worldId, ...rest } = args;
    await ctx.db.insert('townEvents', { worldId, ts: Date.now(), ...rest });
  },
});

export const listChronicle = query({
  args: { worldId: v.id('worlds'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('townEvents')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .order('desc')
      .take(args.limit ?? 60);
  },
});
