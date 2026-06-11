import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { playerId } from './ids';
import { chatCompletion } from '../util/llm';

// v1.2 Steps 3-4 — the data + LLM helpers agents use to post to the feed and send DMs.

// Everything an agent needs to decide whether (and what) to post or message, in one query.
export const commsContext = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) return null;
    const agent = world.agents.find((a) => a.playerId === args.playerId);
    if (!agent) return null;
    const myDesc = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    if (!myDesc) return null;
    const agentDesc = await ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('agentId', agent.id))
      .first();
    const recent = await ctx.db
      .query('memories')
      .withIndex('playerId', (q) => q.eq('playerId', args.playerId))
      .order('desc')
      .take(5);
    const others: { playerId: string; name: string }[] = [];
    for (const a of world.agents) {
      if (a.playerId === args.playerId) continue;
      const d = await ctx.db
        .query('playerDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', a.playerId))
        .first();
      if (d) others.push({ playerId: a.playerId, name: d.name });
    }
    const state = await ctx.db
      .query('agentCommsState')
      .withIndex('playerId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    return {
      name: myDesc.name,
      identity: agentDesc?.identity ?? '',
      plan: agentDesc?.plan ?? '',
      memories: recent.map((m) => m.description),
      others,
      lastFeedPostAt: state?.lastFeedPostAt ?? 0,
      lastDmAt: state?.lastDmAt ?? 0,
      lastThoughtAt: state?.lastThoughtAt ?? 0,
    };
  },
});

async function upsertState(
  ctx: any,
  worldId: string,
  pid: string,
  patch: { lastFeedPostAt?: number; lastDmAt?: number; lastThoughtAt?: number },
) {
  const existing = await ctx.db
    .query('agentCommsState')
    .withIndex('playerId', (q: any) => q.eq('worldId', worldId).eq('playerId', pid))
    .first();
  if (existing) await ctx.db.patch(existing._id, patch);
  else await ctx.db.insert('agentCommsState', { worldId, playerId: pid, ...patch });
}

export const recordFeedPost = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastFeedPostAt: args.at }),
});

export const recordDm = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastDmAt: args.at }),
});

export const recordThought = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastThoughtAt: args.at }),
});

function cleanLine(s: string): string {
  return s.replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 280);
}

const memBlock = (memories: string[]) =>
  memories.length ? `Recently on your mind:\n- ${memories.join('\n- ')}\n` : '';

export async function composeFeedPost(args: {
  name: string;
  identity: string;
  plan: string;
  memories: string[];
  research: boolean;
  timeContext?: string;
}): Promise<string> {
  const prompt =
    `You are ${args.name}. ${args.identity}\n${args.plan}\n${memBlock(args.memories)}` +
    (args.timeContext ? `${args.timeContext}\n` : '') +
    `Write ONE short public post for the town feed (the town's "internet"), in your own voice ` +
    `and opinions, under 200 characters. ` +
    (args.research
      ? 'Frame it as sharing a finding, result, or progress from your work. '
      : 'A hot take, an observation about what is happening in town, or a personal update. ') +
    `No hashtags. No quotation marks. Output only the post text.\nPost:`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 120,
    stop: ['\n\n'],
  });
  return cleanLine(content);
}

// An unprompted inner thought — first-person, fleeting, grounded in what's recently been on
// their mind and what they're doing right now. Their private stream of consciousness (v1.3).
export async function composeThought(args: {
  name: string;
  identity: string;
  plan: string;
  memories: string[];
  timeContext?: string;
}): Promise<string> {
  const prompt =
    `You are ${args.name}. ${args.identity}\n${args.plan}\n${memBlock(args.memories)}` +
    (args.timeContext ? `${args.timeContext}\n` : '') +
    `You're walking through town, alone with your thoughts. Write ONE short private thought ` +
    `you're having right now — first person, unfiltered, under 160 characters. It can be about ` +
    `someone, your work, something you noticed or are worried or excited about, or just a passing ` +
    `mood. Not addressed to anyone. No quotation marks. Output only the thought.\nThought:`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 100,
    stop: ['\n\n'],
  });
  return cleanLine(content);
}

export async function composeDirectMessage(args: {
  name: string;
  identity: string;
  plan: string;
  toName: string;
  memories: string[];
  timeContext?: string;
}): Promise<string> {
  const prompt =
    `You are ${args.name}. ${args.identity}\n${args.plan}\n${memBlock(args.memories)}` +
    (args.timeContext ? `${args.timeContext}\n` : '') +
    `Write ONE short direct message to ${args.toName} (you can reach them even though they ` +
    `aren't nearby), under 200 characters, in your own voice. It might be a question, an ` +
    `invitation, a reaction to recent news, or something on your mind. No quotation marks. ` +
    `Output only the message text.\nMessage:`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 120,
    stop: ['\n\n'],
  });
  return cleanLine(content);
}
