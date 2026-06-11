import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { playerId } from './aiTown/ids';

// v1.2 Step 1 — the public feed ("the internet" / town groupchat).
// Read-only display + human/news posting for now. Agent perception (Step 2) and agent
// posting (Step 3) build on this same table. See docs/V1.2-COMMS.md.

export const listFeed = query({
  args: {
    worldId: v.id('worlds'),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('feedPosts')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .order('desc')
      .take(args.limit ?? 50);
  },
});

export const postToFeed = mutation({
  args: {
    worldId: v.id('worlds'),
    authorPlayerId: v.optional(v.union(playerId, v.null())),
    authorName: v.string(),
    kind: v.union(v.literal('post'), v.literal('research'), v.literal('news')),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const text = args.text.trim();
    if (!text) return null;
    const postId = await ctx.db.insert('feedPosts', {
      worldId: args.worldId,
      authorPlayerId: args.authorPlayerId ?? null,
      authorName: args.authorName,
      kind: args.kind,
      text,
      createdAt: Date.now(),
    });
    // Deliver the post into every agent's memory stream so the town perceives it (Step 2).
    await ctx.scheduler.runAfter(0, internal.agent.memory.deliverFeedPost, {
      worldId: args.worldId,
      postId,
    });
    return postId;
  },
});
