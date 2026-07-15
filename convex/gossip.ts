import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, internalQuery, query } from './_generated/server';
import { playerId } from './aiTown/ids';
import { gossipNudge } from '../data/gossip';

// Terrarium v2.4 — GOSSIP storage + propagation. The thin Convex layer; the dynamics (who gossips,
// about whom, how much it moves the listener) live in data/gossip.ts and agentOperations.maybeGossip.

// Record a piece of gossip and let it ripple: insert the event, then nudge the LISTENER's view of the
// (absent) subject toward the speaker's valence, scaled by `credibility` (the listener's trust in the
// speaker, 0..1 — computed by the caller). Gentle and signed, so praise lifts and complaint cools.
export const recordGossip = internalMutation({
  args: {
    worldId: v.id('worlds'),
    speakerPlayerId: playerId,
    speakerName: v.string(),
    listenerPlayerId: playerId,
    listenerName: v.string(),
    subjectPlayerId: playerId,
    subjectName: v.string(),
    valence: v.number(),
    credibility: v.number(),
    line: v.string(),
    day: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert('gossipEvents', {
      worldId: args.worldId,
      speakerPlayerId: args.speakerPlayerId,
      speakerName: args.speakerName,
      listenerPlayerId: args.listenerPlayerId,
      listenerName: args.listenerName,
      subjectPlayerId: args.subjectPlayerId,
      subjectName: args.subjectName,
      valence: args.valence,
      line: args.line.slice(0, 240),
      day: args.day,
      createdAt: now,
    });

    // Propagate: shift how the listener feels about the subject (third-party reputation).
    const v01 = args.valence >= 0 ? 1 : -1;
    const { warmth, respect } = gossipNudge(v01, args.credibility);
    if (warmth || respect) {
      await ctx.runMutation(internal.relationships.nudgeDirected, {
        worldId: args.worldId,
        fromPlayerId: args.listenerPlayerId,
        fromName: args.listenerName,
        toPlayerId: args.subjectPlayerId,
        toName: args.subjectName,
        warmth,
        respect,
      });
    }

    // Leave a chronicle beat.
    await ctx.db.insert('townEvents', {
      worldId: args.worldId,
      ts: now,
      kind: 'relationship',
      playerName: args.speakerName,
      subjectName: args.subjectName,
      emoji: args.valence >= 0 ? '🗣️' : '👂',
      summary: `${args.speakerName} to ${args.listenerName}, about ${args.subjectName}: "${args.line.slice(
        0,
        140,
      )}"`,
    });
  },
});

// For the conversation layer: the latest thing THIS character has heard about the person they're now
// talking to, so secondhand impressions color how they treat each other.
export const heardAbout = internalQuery({
  args: { worldId: v.id('worlds'), listenerPlayerId: playerId, subjectPlayerId: playerId },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('gossipEvents')
      .withIndex('byListener', (q) =>
        q.eq('worldId', args.worldId).eq('listenerPlayerId', args.listenerPlayerId),
      )
      .collect();
    const aboutThem = rows
      .filter((r) => r.subjectPlayerId === args.subjectPlayerId)
      .sort((a, b) => b.createdAt - a.createdAt);
    if (!aboutThem.length) return null;
    const g = aboutThem[0];
    return { speakerName: g.speakerName, line: g.line, valence: g.valence };
  },
});

// UI: what's being said ABOUT this character lately (the rumor mill, from their side).
export const forSubject = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('gossipEvents')
      .withIndex('bySubject', (q) =>
        q.eq('worldId', args.worldId).eq('subjectPlayerId', args.playerId),
      )
      .collect();
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 8)
      .map((g) => ({
        id: g._id,
        speakerName: g.speakerName,
        listenerName: g.listenerName,
        line: g.line,
        valence: g.valence,
        day: g.day,
      }));
  },
});
