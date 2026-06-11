import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { playerId } from './aiTown/ids';

// v1.2 Step 4 — async direct messages between agents, delivered regardless of distance.
// Like the feed, a DM is delivered into the recipient's memory stream (see memory.ts
// deliverDirectMessage) so it can be perceived and referenced even when not co-located.

export const sendDirectMessage = mutation({
  args: {
    worldId: v.id('worlds'),
    fromPlayerId: playerId,
    fromName: v.string(),
    toPlayerId: playerId,
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const text = args.text.trim();
    if (!text) return null;
    const messageId = await ctx.db.insert('directMessages', {
      worldId: args.worldId,
      fromPlayerId: args.fromPlayerId,
      fromName: args.fromName,
      toPlayerId: args.toPlayerId,
      text,
      createdAt: Date.now(),
      readAt: null,
    });
    await ctx.scheduler.runAfter(0, internal.agent.memory.deliverDirectMessage, {
      worldId: args.worldId,
      messageId,
    });
    return messageId;
  },
});

// Recent DMs to or from a player, newest first.
export const listInbox = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const to = await ctx.db
      .query('directMessages')
      .withIndex('to', (q) => q.eq('worldId', args.worldId).eq('toPlayerId', args.playerId))
      .order('desc')
      .take(25);
    const from = await ctx.db
      .query('directMessages')
      .withIndex('from', (q) => q.eq('worldId', args.worldId).eq('fromPlayerId', args.playerId))
      .order('desc')
      .take(25);
    return [...to, ...from].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
  },
});
