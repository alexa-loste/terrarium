import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';
import { playerId } from './aiTown/ids';

// v1.6 — real work output. Agents create these when they work their jobs (see
// agentOperations.maybeMakeArtifact). They are read-only town history for the observer + a
// substrate other agents respond to.

export const createArtifact = internalMutation({
  args: {
    worldId: v.id('worlds'),
    authorPlayerId: playerId,
    authorName: v.string(),
    workType: v.string(),
    emoji: v.string(),
    title: v.string(),
    body: v.string(),
    respondsTo: v.optional(v.string()),
    placeName: v.optional(v.string()),
    day: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('artifacts', { ...args, createdAt: Date.now() });
  },
});

// The most recent works in town, newest first — for the Library panel.
export const listArtifacts = query({
  args: { worldId: v.id('worlds'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('artifacts')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .order('desc')
      .take(args.limit ?? 60);
    return rows;
  },
});

// A few recent works (titles + types + authors) — the discourse context handed to an agent so
// new work can build on / respond to what the town has lately published.
export const recentForContext = query({
  args: { worldId: v.id('worlds'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('artifacts')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .order('desc')
      .take(args.limit ?? 5);
    return rows.map((r) => ({
      authorName: r.authorName,
      authorPlayerId: r.authorPlayerId,
      workType: r.workType,
      title: r.title,
    }));
  },
});

// Everything a single person has made, newest first — for their player panel.
export const listByAuthor = query({
  args: { worldId: v.id('worlds'), authorPlayerId: playerId },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('artifacts')
      .withIndex('author', (q) =>
        q.eq('worldId', args.worldId).eq('authorPlayerId', args.authorPlayerId),
      )
      .order('desc')
      .take(40);
  },
});

// Per-author counts, for a 📚 badge — how prolific each person has been.
export const countsByAuthor = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('artifacts')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.authorPlayerId, (counts.get(r.authorPlayerId) ?? 0) + 1);
    return [...counts.entries()].map(([authorPlayerId, count]) => ({ authorPlayerId, count }));
  },
});
