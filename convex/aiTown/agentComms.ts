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
      lastArtifactAt: state?.lastArtifactAt ?? 0,
      lastJournalAt: state?.lastJournalAt ?? 0,
      lastReactAt: state?.lastReactAt ?? 0,
    };
  },
});

async function upsertState(
  ctx: any,
  worldId: string,
  pid: string,
  patch: {
    lastFeedPostAt?: number;
    lastDmAt?: number;
    lastThoughtAt?: number;
    lastArtifactAt?: number;
    lastJournalAt?: number;
    lastReactAt?: number;
  },
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

export const recordArtifact = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastArtifactAt: args.at }),
});

export const recordJournal = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastJournalAt: args.at }),
});

export const recordReact = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastReactAt: args.at }),
});

function cleanLine(s: string): string {
  return s.replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 280);
}

const memBlock = (memories: string[]) =>
  memories.length ? `Recently on your mind:\n- ${memories.join('\n- ')}\n` : '';

// v1.8 — the convictions a character writes/argues/reacts from. Belief = {topic, statement,
// conviction 0..100}. Strong ones lead; weak ones are flagged as held loosely.
export type Belief = { topic: string; statement: string; conviction: number };
const beliefBlock = (beliefs?: Belief[]) =>
  beliefs && beliefs.length
    ? `What you believe (write and argue from these; they are yours):\n` +
      beliefs
        .map((b) => `- ${b.statement}${b.conviction < 45 ? ' (though you hold this loosely)' : ''}`)
        .join('\n') +
      '\n'
    : '';

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

// v1.6 — produce a real piece of work (artifact). The brief comes from data/artifacts.ts and
// is role-specific; `recent` is a few things the town has lately published so this work can
// respond to / build on the discourse. Returns a parsed { title, body } or null on failure.
export async function composeArtifact(args: {
  name: string;
  identity: string;
  plan: string;
  brief: string;
  workType: string;
  memories: string[];
  recent: { authorName: string; workType: string; title: string }[];
  beliefs?: Belief[];
  placeName?: string;
  timeContext?: string;
}): Promise<{ title: string; body: string; respondsTo?: string } | null> {
  const recentBlock = args.recent.length
    ? `Recently published around town (you may build on, cite, or push back on one of these):\n` +
      args.recent.map((r) => `- ${r.authorName}'s ${r.workType}: "${r.title}"`).join('\n') +
      '\n'
    : '';
  const prompt =
    `You are ${args.name}. ${args.identity}\n${args.plan}\n${memBlock(args.memories)}` +
    beliefBlock(args.beliefs) +
    (args.placeName ? `You're working at ${args.placeName}.\n` : '') +
    (args.timeContext ? `${args.timeContext}\n` : '') +
    recentBlock +
    `Produce a real piece of work — ${args.brief}\n` +
    `Give it a TITLE (under 70 characters) and a BODY of 2-4 sentences. Write it for real, in ` +
    `your own voice and point of view — not a description of writing it. ` +
    `If you are responding to someone's recent work above, name them in the body.\n` +
    `Format EXACTLY as:\nTITLE: <the title>\nBODY: <the body>`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 320,
  });
  const titleMatch = content.match(/TITLE:\s*(.+?)(?:\n|$)/i);
  const bodyMatch = content.match(/BODY:\s*([\s\S]+)$/i);
  if (!bodyMatch) return null;
  const title = (titleMatch?.[1] ?? `${args.name}'s ${args.workType}`)
    .trim()
    .replace(/^["']|["']$/g, '')
    .slice(0, 90);
  const body = bodyMatch[1].trim().replace(/^["']|["']$/g, '').slice(0, 900);
  if (!body) return null;
  // Did this work respond to a recent piece? Note the first recent title it names.
  const respondsTo = args.recent.find(
    (r) => body.includes(r.authorName) && r.authorName !== args.name,
  )?.title;
  return { title, body, respondsTo };
}

// v1.7 — a private journal entry. First-person, unguarded, the place they're honest with
// themselves. The framing depends on what prompted it (nightly wind-down, a conversation, a
// piece they made, an event, or just something on their mind).
export type JournalTrigger = 'reflection' | 'conversation' | 'artifact' | 'event' | 'spontaneous';

function journalFraming(trigger: JournalTrigger, context?: string): string {
  switch (trigger) {
    case 'reflection':
      return `It's the end of the day and you're winding down before sleep. Look back on the day — what happened, how you feel about it, what's unresolved.`;
    case 'conversation':
      return `You just finished talking with ${context ?? 'someone'}. Write honestly about how it went and how it left you feeling.`;
    case 'artifact':
      return `You just finished a piece of work${context ? ` — "${context}"` : ''}. Write about the work: whether it's any good, what it cost you, what it's for.`;
    case 'event':
      return `Something happened today that you can't stop thinking about: ${context ?? 'a piece of news'}. Write about what it means for you.`;
    case 'spontaneous':
      return `Something's been sitting with you. Open your journal and write it down — whatever it actually is.`;
  }
}

export async function composeJournalEntry(args: {
  name: string;
  identity: string;
  plan: string;
  memories: string[];
  trigger: JournalTrigger;
  context?: string;
  timeContext?: string;
}): Promise<string> {
  const prompt =
    `You are ${args.name}. ${args.identity}\n${args.plan}\n${memBlock(args.memories)}` +
    (args.timeContext ? `${args.timeContext}\n` : '') +
    `${journalFraming(args.trigger, args.context)}\n` +
    `Write a private journal entry — first person, honest and specific, 2-4 sentences, in your ` +
    `own voice. This is for no one but you. No salutation, no signature, no quotation marks. ` +
    `Output only the entry.\nEntry:`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 220,
    stop: ['\n\n'],
  });
  return content.replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 700);
}

const clampInt = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(n)));
const firstInt = (s?: string): number | null => {
  const m = s?.match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
};

// v1.8 — react to someone else's work, through the lens of your convictions. Returns the felt
// reaction plus how it moved you: which of YOUR belief topics it touched, whether it reinforced
// (+) or shook (–) that conviction, and how it changed what you think of the author. A piece
// that conflicts with a strong belief produces a strong reaction; one you agree with warms you
// to them. Parsed leniently; null only if the model gives nothing usable.
export async function composeReaction(args: {
  name: string;
  identity: string;
  beliefs: Belief[];
  piece: { authorName: string; workType: string; title: string; body: string };
  timeContext?: string;
}): Promise<{
  reaction: string;
  topic: string;
  convictionDelta: number;
  affinityDelta: number;
  respectDelta: number;
} | null> {
  const prompt =
    `You are ${args.name}. ${args.identity}\n` +
    beliefBlock(args.beliefs) +
    (args.timeContext ? `${args.timeContext}\n` : '') +
    `You just read ${args.piece.authorName}'s ${args.piece.workType}, "${args.piece.title}":\n` +
    `"${args.piece.body}"\n\n` +
    `React honestly, through your own convictions. Then report how it moved you.\n` +
    `Format EXACTLY as:\n` +
    `REACTION: <1-2 sentences, first person — what you think of it>\n` +
    `TOPIC: <which of your beliefs it touches, or none>\n` +
    `CONVICTION: <integer -8..8: negative if it shook your conviction, positive if it hardened it>\n` +
    `AFFINITY: <integer -3..3: how it changed your warmth toward ${args.piece.authorName}>\n` +
    `RESPECT: <integer -3..3: how it changed your respect for ${args.piece.authorName}>`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 220,
  });
  const reactionMatch = content.match(/REACTION:\s*([\s\S]*?)(?:\nTOPIC:|\nCONVICTION:|$)/i);
  const reaction = (reactionMatch?.[1] ?? '').trim().replace(/^["']|["']$/g, '').slice(0, 300);
  if (!reaction) return null;
  const topic = (content.match(/TOPIC:\s*(.+?)(?:\n|$)/i)?.[1] ?? 'none')
    .trim()
    .replace(/^["']|["']$/g, '')
    .slice(0, 40);
  return {
    reaction,
    topic,
    convictionDelta: clampInt(firstInt(content.match(/CONVICTION:\s*(-?\d+)/i)?.[1]) ?? 0, -8, 8),
    affinityDelta: clampInt(firstInt(content.match(/AFFINITY:\s*(-?\d+)/i)?.[1]) ?? 0, -3, 3),
    respectDelta: clampInt(firstInt(content.match(/RESPECT:\s*(-?\d+)/i)?.[1]) ?? 0, -3, 3),
  };
}

// v1.8 — the overnight belief drift. Looking back on the day's experiences, which convictions
// (if any) moved, and by how much (small: -5..5). Returns a list of {topic, delta}; empty if
// the day didn't change anyone's mind. One cheap call during consolidation.
export async function assessBeliefDrift(args: {
  name: string;
  beliefs: Belief[];
  dayMemories: string[];
}): Promise<{ topic: string; delta: number }[]> {
  if (!args.beliefs.length) return [];
  const prompt =
    `You are ${args.name}.\n` +
    `Your current convictions:\n` +
    args.beliefs.map((b) => `- [${b.topic}] ${b.statement} (strength ${b.conviction})`).join('\n') +
    `\n\nLooking back on your day:\n- ${(args.dayMemories.length ? args.dayMemories : ['(an ordinary day)']).join('\n- ')}\n\n` +
    `Did anything today move any of these convictions? For each belief that shifted, output one ` +
    `line: <topic> | <integer -5..5> (negative = weakened, positive = strengthened). Only include ` +
    `beliefs that actually moved. If nothing changed, output exactly: none\nChanges:`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 120,
  });
  if (/^\s*none\b/i.test(content)) return [];
  const out: { topic: string; delta: number }[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*[-*]?\s*(.+?)\s*\|\s*(-?\d+)/);
    if (m) {
      const delta = clampInt(parseInt(m[2], 10), -5, 5);
      if (delta !== 0) out.push({ topic: m[1].trim().slice(0, 40), delta });
    }
  }
  return out.slice(0, 3);
}
