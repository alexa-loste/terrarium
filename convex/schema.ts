import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { agentTables } from './agent/schema';
import { aiTownTables } from './aiTown/schema';
import { conversationId, playerId } from './aiTown/ids';
import { engineTables } from './engine/schema';

export default defineSchema({
  music: defineTable({
    storageId: v.string(),
    type: v.union(v.literal('background'), v.literal('player')),
  }),

  messages: defineTable({
    conversationId,
    messageUuid: v.string(),
    author: playerId,
    text: v.string(),
    worldId: v.optional(v.id('worlds')),
  })
    .index('conversationId', ['worldId', 'conversationId'])
    .index('messageUuid', ['conversationId', 'messageUuid']),

  // The public "internet" feed: posts, "research", and world/news events. v1.2 Step 1.
  feedPosts: defineTable({
    worldId: v.id('worlds'),
    // authorPlayerId is set when an agent posts (v1.2 Step 3); null for human/news posts.
    authorPlayerId: v.union(playerId, v.null()),
    authorName: v.string(),
    kind: v.union(v.literal('post'), v.literal('research'), v.literal('news')),
    text: v.string(),
    createdAt: v.number(),
  }).index('worldId', ['worldId']),

  // Async direct messages between agents (v1.2 Step 4) — delivered regardless of distance.
  directMessages: defineTable({
    worldId: v.id('worlds'),
    fromPlayerId: playerId,
    fromName: v.string(),
    toPlayerId: playerId,
    text: v.string(),
    createdAt: v.number(),
    readAt: v.union(v.number(), v.null()),
  })
    .index('to', ['worldId', 'toPlayerId'])
    .index('from', ['worldId', 'fromPlayerId']),

  // Per-agent rate-limit cursors for posting / messaging (v1.2 Steps 3-4).
  agentCommsState: defineTable({
    worldId: v.id('worlds'),
    playerId,
    lastFeedPostAt: v.optional(v.number()),
    lastDmAt: v.optional(v.number()),
  }).index('playerId', ['worldId', 'playerId']),

  // The anchored day/night clock (v1.3). One row per world; see data/clock.ts + convex/clock.ts.
  worldClock: defineTable({
    worldId: v.id('worlds'),
    epochRealMs: v.number(),
    epochWorldMs: v.number(),
    speed: v.number(),
  }).index('worldId', ['worldId']),

  ...agentTables,
  ...aiTownTables,
  ...engineTables,
});
