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

  // Per-agent rate-limit cursors for posting / messaging / thinking (v1.2 Steps 3-4, v1.3).
  agentCommsState: defineTable({
    worldId: v.id('worlds'),
    playerId,
    lastFeedPostAt: v.optional(v.number()),
    lastDmAt: v.optional(v.number()),
    lastThoughtAt: v.optional(v.number()),
  }).index('playerId', ['worldId', 'playerId']),

  // The Town Chronicle (v1.3): a god-view stream of gisted events — inner thoughts,
  // conversation summaries, feed posts, and (later) relationship + artifact updates.
  // The observer's readable digest; written from the existing event hooks.
  townEvents: defineTable({
    worldId: v.id('worlds'),
    ts: v.number(),
    kind: v.union(
      v.literal('thought'),
      v.literal('conversation'),
      v.literal('feed'),
      v.literal('relationship'),
      v.literal('artifact'),
      v.literal('system'),
    ),
    // The agent at the center of the event, if any.
    playerId: v.optional(playerId),
    playerName: v.optional(v.string()),
    // A second party (e.g. the other side of a conversation).
    subjectName: v.optional(v.string()),
    emoji: v.optional(v.string()),
    summary: v.string(),
  }).index('worldId', ['worldId', 'ts']),

  // The anchored day/night clock (v1.3). One row per world; see data/clock.ts + convex/clock.ts.
  // `frozen` pauses world-time when the world is frozen, so the clock stops with the sim.
  worldClock: defineTable({
    worldId: v.id('worlds'),
    epochRealMs: v.number(),
    epochWorldMs: v.number(),
    speed: v.number(),
    frozen: v.optional(v.boolean()),
  }).index('worldId', ['worldId']),

  // Per-agent vitals + economy (v1.3 energy/sleep, v1.4 food/money).
  // energy drains while awake, recharges by sleeping; food drains while awake, refills by
  // eating (which costs money); money is earned by working your job during work hours.
  agentVitals: defineTable({
    worldId: v.id('worlds'),
    playerId,
    energy: v.number(), // 0..100
    asleep: v.boolean(),
    lastConsolidatedDay: v.number(), // world-day index of the last overnight reflection
    food: v.optional(v.number()), // 0..100
    money: v.optional(v.number()),
    social: v.optional(v.number()), // 0..100 — feeling connected/supported/liked (v1.5)
  }).index('playerId', ['worldId', 'playerId']),

  // The relationship graph (v1.5): a directed edge per ordered pair, holding how `from` feels
  // about `to` across a few dimensions. Updated from conversation outcomes and persisting as
  // numbers even after the conversation text is gisted away. Reputation is derived from the
  // inbound edges (see convex/relationships.ts).
  relationships: defineTable({
    worldId: v.id('worlds'),
    fromPlayerId: playerId,
    toPlayerId: playerId,
    familiarity: v.number(), // 0..100 — how well they know them
    affinity: v.number(), // 0..100 — warmth / liking (50 = neutral)
    respect: v.number(), // 0..100 — esteem (50 = neutral)
    trust: v.number(), // 0..100 (50 = neutral)
    romantic: v.number(), // 0..100 — romantic feeling (0 = none)
    updatedAt: v.number(),
  })
    .index('edge', ['worldId', 'fromPlayerId', 'toPlayerId'])
    .index('inbound', ['worldId', 'toPlayerId'])
    .index('outbound', ['worldId', 'fromPlayerId']),

  ...agentTables,
  ...aiTownTables,
  ...engineTables,
});
