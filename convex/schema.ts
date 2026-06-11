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

  ...agentTables,
  ...aiTownTables,
  ...engineTables,
});
