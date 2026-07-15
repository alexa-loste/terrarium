import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { playerId } from './ids';
import { chatCompletion, stripMetaCommentary } from '../util/llm';

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
      lastPlanAt: state?.lastPlanAt ?? 0,
      lastGatherAt: state?.lastGatherAt ?? 0,
      lastFactionAt: state?.lastFactionAt ?? 0,
      lastFactionMoveAt: state?.lastFactionMoveAt ?? 0,
      lastGossipAt: state?.lastGossipAt ?? 0,
      lastIssueAt: state?.lastIssueAt ?? 0,
      lastLobbyAt: state?.lastLobbyAt ?? 0,
      lastReciprocateAt: state?.lastReciprocateAt ?? 0,
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
    lastPlanAt?: number;
    lastGatherAt?: number;
    lastFactionAt?: number;
    lastFactionMoveAt?: number;
    lastGossipAt?: number;
    lastIssueAt?: number;
    lastLobbyAt?: number;
    lastReciprocateAt?: number;
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
  handler: (ctx, args) =>
    upsertState(ctx, args.worldId, args.playerId, { lastFeedPostAt: args.at }),
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
  handler: (ctx, args) =>
    upsertState(ctx, args.worldId, args.playerId, { lastArtifactAt: args.at }),
});

export const recordJournal = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastJournalAt: args.at }),
});

export const recordReact = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastReactAt: args.at }),
});

export const recordPlan = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastPlanAt: args.at }),
});

export const recordGather = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastGatherAt: args.at }),
});

export const recordFaction = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastFactionAt: args.at }),
});

export const recordFactionMove = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) =>
    upsertState(ctx, args.worldId, args.playerId, { lastFactionMoveAt: args.at }),
});

export const recordGossipState = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastGossipAt: args.at }),
});

export const recordIssue = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastIssueAt: args.at }),
});

export const recordLobby = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) => upsertState(ctx, args.worldId, args.playerId, { lastLobbyAt: args.at }),
});

export const recordReciprocate = internalMutation({
  args: { worldId: v.id('worlds'), playerId, at: v.number() },
  handler: (ctx, args) =>
    upsertState(ctx, args.worldId, args.playerId, { lastReciprocateAt: args.at }),
});

// Sentence-aware safety net: if the model ever runs past `max`, end on the last complete sentence
// (else the last word + ellipsis), never mid-word. The cap sits ABOVE what max_tokens can emit
// (~480-600 chars at 120 tokens), so a normal post/thought/DM ends at the model's own natural stop
// and is never chopped — matching the artifact/journal pattern (v2.2). Only true runaways hit it.
function smartCap(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (lastStop > max * 0.5) return slice.slice(0, lastStop + 1).trimEnd();
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > max * 0.5 ? slice.slice(0, lastSpace) : slice).trimEnd() + '…';
}

function cleanLine(s: string, max = 600): string {
  // Strip the model's task-narration leak ("Task Summary: …") before trimming quotes/length, so a
  // feed post / thought / DM never carries out-of-world meta-commentary.
  return smartCap(stripMetaCommentary(s).replace(/^["'\s]+|["'\s]+$/g, '').trim(), max);
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
  beliefs?: Belief[];
  timeContext?: string;
}): Promise<string> {
  const prompt =
    `You are ${args.name}. ${args.identity}\n${args.plan}\n${memBlock(args.memories)}` +
    beliefBlock(args.beliefs) +
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
  beliefs?: Belief[];
  timeContext?: string;
  // v2.8 — the same inner state that colors their dialogue (mood, drives, allegiance + rival, the
  // live town vote, friction temperament), so private thoughts carry the stakes too instead of
  // reading as pleasant idle musing.
  inner?: string[];
}): Promise<string> {
  const innerBlock = args.inner && args.inner.length ? args.inner.join('\n') + '\n' : '';
  const prompt =
    `You are ${args.name}. ${args.identity}\n${args.plan}\n${memBlock(args.memories)}` +
    beliefBlock(args.beliefs) +
    innerBlock +
    (args.timeContext ? `${args.timeContext}\n` : '') +
    `You're walking through town, alone with your thoughts. Write ONE short private thought ` +
    `you're having right now — first person, unfiltered, under 160 characters. It can be about ` +
    `someone, your work, something you noticed or are worried or excited about, or just a passing ` +
    `mood. Let whatever's genuinely on your mind surface honestly — even if it's not pleasant or ` +
    `tidy. Not addressed to anyone. No quotation marks. Output only the thought.\nThought:`;
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
  beliefs?: Belief[];
  timeContext?: string;
}): Promise<string> {
  const prompt =
    `You are ${args.name}. ${args.identity}\n${args.plan}\n${memBlock(args.memories)}` +
    beliefBlock(args.beliefs) +
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
  // Note: we deliberately do NOT feed in recent memories here. Those are mostly conversation
  // recaps ("I talked with X about Y"), and the model parrots them back as the artifact —
  // producing a chatty status update instead of real work. Ground the piece in role + beliefs.
  const prompt =
    `You are ${args.name}. ${args.identity}\n${args.plan}\n` +
    beliefBlock(args.beliefs) +
    (args.placeName ? `You're working at ${args.placeName}.\n` : '') +
    (args.timeContext ? `${args.timeContext}\n` : '') +
    recentBlock +
    `Produce a real, finished piece of work — ${args.brief}\n` +
    `This is the WORK ITSELF — the kind of thing that sits in the town library with your name ` +
    `on it and that a stranger could read years from now and learn something concrete. Put real ` +
    `substance in it: a specific claim, finding, proposal, argument, or described creation that ` +
    `stands on its own.\n` +
    `Do NOT recap your day or a conversation. Do NOT begin with "Just had a chat/talk with…", ` +
    `do NOT write a social-media update, a status post, or a note about how you feel. No "I had ` +
    `a great conversation with…". Write the actual content of the work.\n` +
    `Give it a TITLE that is a real headline for the piece (under 70 characters) and then the ` +
    `BODY, in your own voice and point of view. Let the length follow the idea: a sharp single ` +
    `paragraph if that's all it needs, or several paragraphs if you want to actually develop the ` +
    `argument, work an example, or explore the idea in depth — write as much as the piece deserves ` +
    `and no more. If you are deliberately responding to someone's published work above, engage its ` +
    `actual argument and name them.\n` +
    `Format EXACTLY as:\nTITLE: <the title>\nBODY: <the body>`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 900,
  });
  const titleMatch = content.match(/TITLE:\s*(.+?)(?:\n|$)/i);
  const bodyMatch = content.match(/BODY:\s*([\s\S]+)$/i);
  if (!bodyMatch) return null;
  const title = (titleMatch?.[1] ?? `${args.name}'s ${args.workType}`)
    .trim()
    .replace(/^["']|["']$/g, '')
    .slice(0, 90);
  // Open-ended: the char cap sits well above what max_tokens can emit, so a piece only ever ends
  // at the model's own natural stop — never chopped mid-sentence (v2.2).
  const body = stripMetaCommentary(bodyMatch[1])
    .trim()
    .replace(/^["']|["']$/g, '')
    .slice(0, 4000);
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
  // Length stays as-is (one honest paragraph, capped by max_tokens + the \n\n stop). The char cap
  // just sits above the token budget so a full entry ends cleanly instead of being chopped (v2.2).
  return stripMetaCommentary(content)
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .slice(0, 1200);
}

const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
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
  const reaction = (reactionMatch?.[1] ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .slice(0, 300);
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

// v2.10 — belief FORMATION. assessBeliefDrift only nudges convictions a character ALREADY holds;
// the idea-space never grows (netNewBeliefs stayed 0 across 65 days — the gap the vitals
// instrument surfaced). This is the missing half: sleeping on a charged day, a character can wake
// up holding a genuinely NEW conviction on a topic they didn't have one on before — crystallized
// from what actually happened to them. Deliberately STRICT (like detectPlan): most nights nothing
// forms. Only a real, strongly-felt new stance counts — not a restatement of an existing belief,
// not a passing mood. Returns one new belief or null. Inserted via beliefs.addBelief (which dedupes
// on topic, so a near-duplicate is harmlessly dropped).
export async function assessBeliefFormation(args: {
  name: string;
  identity: string;
  existingTopics: string[];
  dayMemories: string[];
}): Promise<{ topic: string; statement: string; conviction: number } | null> {
  if (!args.dayMemories.length) return null; // an ordinary day forms nothing
  const held = args.existingTopics.length
    ? `You already hold convictions about: ${args.existingTopics.join(', ')}. A new belief must be on a DIFFERENT subject.\n`
    : '';
  const prompt =
    `You are ${args.name}. ${args.identity}\n\n` +
    `Looking back on your day:\n- ${args.dayMemories.join('\n- ')}\n\n` +
    held +
    `Did something today crystallize a genuinely NEW conviction in you — a stance you hadn't put ` +
    `into words before, that you now actually hold? This is rare: most days deepen what you already ` +
    `believe rather than form something new. Only a real, strongly-felt new conviction counts — not ` +
    `a fleeting reaction, not a rephrasing of what you already think.\n` +
    `If nothing new formed, output exactly: NONE\n` +
    `If something did, output EXACTLY these three lines:\n` +
    `TOPIC: <short handle for the subject, under 40 chars>\n` +
    `STATEMENT: <the conviction itself, first person, in your voice, under 240 chars>\n` +
    `STRENGTH: <integer 50-85, how firmly you now hold it>`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 140,
  });
  if (/^\s*none\b/i.test(content) || !/TOPIC:/i.test(content)) return null;
  const topic = cleanLine(content.match(/TOPIC:\s*(.+?)(?:\n|$)/i)?.[1] ?? '').slice(0, 40);
  const statement = cleanLine(content.match(/STATEMENT:\s*(.+?)(?:\n|$)/i)?.[1] ?? '').slice(0, 240);
  if (!topic || !statement || /^none$/i.test(topic)) return null;
  // don't re-form a topic they already hold (belt-and-suspenders; addBelief also dedupes).
  if (args.existingTopics.some((t) => t.toLowerCase() === topic.toLowerCase())) return null;
  const strengthRaw = content.match(/STRENGTH:\s*(.+?)(?:\n|$)/i)?.[1];
  const conviction =
    strengthRaw && /\d/.test(strengthRaw) ? clampInt(firstInt(strengthRaw)!, 40, 90) : 60;
  return { topic, statement, conviction };
}

// v2.0 — read a finished conversation and decide whether the two of them made a concrete plan
// to do something together on a future day. Returns the plan (title + how many days out + an
// optional time/place) or null. The model is told to be STRICT: only a real, specific, mutual
// commitment counts — not "we should hang out sometime", not one person's vague wish. This is
// the single extraction that becomes the shared row both attendees read from, so a false
// positive would put a phantom event on everyone's calendar.
export async function detectPlan(args: {
  nameA: string;
  nameB: string;
  transcript: string;
  places: string[];
  maxDays: number;
}): Promise<{ title: string; dayOffset: number; hour?: number; place?: string } | null> {
  const placeLine = args.places.length
    ? `Places in town they might name: ${args.places.join(', ')}.\n`
    : '';
  const prompt =
    `Here is a conversation between ${args.nameA} and ${args.nameB}:\n\n${args.transcript}\n\n` +
    placeLine +
    `Did they make a CONCRETE, MUTUAL plan to do something together on a FUTURE day — a specific ` +
    `commitment both clearly agreed to (e.g. "let's get coffee tomorrow morning", "see you at the ` +
    `gallery opening in a couple days")? Vague gestures ("we should hang out sometime", "let's ` +
    `catch up soon") do NOT count, and a plan only one of them wanted does NOT count.\n` +
    `If there is NO real plan, output exactly: NONE\n` +
    `If there IS, output EXACTLY these four lines:\n` +
    `TITLE: <short name for the gathering, under 60 chars>\n` +
    `DAYS: <whole number of days from today until it happens, 1-${args.maxDays}>\n` +
    `HOUR: <0-23 if a time of day was agreed, else ->\n` +
    `PLACE: <where, if named, else ->`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 90,
  });
  if (/^\s*none\b/i.test(content) || !/TITLE:/i.test(content)) return null;
  const title = cleanLine(content.match(/TITLE:\s*(.+?)(?:\n|$)/i)?.[1] ?? '').slice(0, 60);
  if (!title || /^none$/i.test(title)) return null;
  const dayOffset = firstInt(content.match(/DAYS:\s*(.+?)(?:\n|$)/i)?.[1]);
  if (dayOffset === null) return null;
  const hourRaw = content.match(/HOUR:\s*(.+?)(?:\n|$)/i)?.[1]?.trim();
  const hourNum = hourRaw && /\d/.test(hourRaw) ? clampInt(firstInt(hourRaw)!, 0, 23) : undefined;
  const placeRaw = content.match(/PLACE:\s*(.+?)(?:\n|$)/i)?.[1]?.trim();
  const place =
    placeRaw && placeRaw !== '-' && !/^none$/i.test(placeRaw) ? placeRaw.slice(0, 40) : undefined;
  return { title, dayOffset, hour: hourNum, place };
}

// v2.9 — goal PURSUIT. During the day a character spends a beat actually working on their most
// pressing short-term goal — one concrete step, in their own voice. This is what was missing: goals
// were set and reviewed but never WORKED, so they rotted to their deadline. Returns one plain
// sentence of what they did toward it (no flourish), or null if nothing usable came back.
export async function composeGoalStep(args: {
  name: string;
  identity: string;
  goal: string;
  daysLeft: number;
  timeContext: string;
}): Promise<string | null> {
  const urgency =
    args.daysLeft <= 0
      ? `It's overdue — you're behind on it.`
      : args.daysLeft === 1
        ? `It's due tomorrow.`
        : `You've got ${args.daysLeft} days left on it.`;
  const prompt =
    `You are ${args.name}. ${args.identity}\n` +
    `${args.timeContext} You're putting in some real time on a goal you're working toward:\n` +
    `"${args.goal}" — ${urgency}\n\n` +
    `In ONE plain first-person sentence, say the concrete thing you actually did just now to move it ` +
    `forward — a real, specific step someone in your situation would take (made the calls, drafted ` +
    `the thing, put in the hours, fixed the problem). Not a feeling, not a plan for later — an action ` +
    `you just took. No flourish.`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 80,
  });
  const step = cleanLine(content).slice(0, 200);
  if (!step || step.length < 8) return null;
  return step;
}

// v2.1 — the nightly goal review. Given the character's long-term aspiration and their current
// short-term milestones, decide which milestones they essentially accomplished today and propose
// the next 1-2 concrete short-term goals that ladder toward the aspiration. One cheap call during
// consolidation. Returns 1-based done-indices (into the shorts list) and new milestones with a
// day-offset. Lenient parse; empty result is fine (an uneventful day).
export async function composeGoalReview(args: {
  name: string;
  identity: string;
  aspiration: string;
  shorts: { text: string; daysLeft: number; workedDays?: number }[];
  dayMemories: string[];
  maxNewDays: number;
}): Promise<{ done: number[]; newShorts: { text: string; days: number }[] }> {
  const shortsBlock = args.shorts.length
    ? args.shorts
        .map((s, i) => {
          const due = `due in ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'}`;
          // How much real effort they've actually put in — grounds the credit decision so a goal is
          // marked done because it was worked, not just because time passed (or left open forever).
          const effort =
            s.workedDays && s.workedDays > 0
              ? `; you've put in real work on ${s.workedDays} day${s.workedDays === 1 ? '' : 's'}`
              : `; you haven't really worked on this one yet`;
          return `${i + 1}. ${s.text} (${due}${effort})`;
        })
        .join('\n')
    : '(none set yet)';
  const prompt =
    `You are ${args.name}. ${args.identity}\n` +
    `Your long-term aim: ${args.aspiration}\n\n` +
    `Your current short-term goals:\n${shortsBlock}\n\n` +
    `Looking back on today:\n- ${(args.dayMemories.length ? args.dayMemories : ['(a quiet, ordinary day)']).join('\n- ')}\n\n` +
    `(a) Which of these short-term goals have you reached or effectively finished by now? Go by the ` +
    `work you actually put in: a goal you've genuinely worked at and whose time has come is done — ` +
    `mark it, don't leave it open forever. A goal you haven't really touched is NOT done just because ` +
    `the deadline arrived — be honest about that one (it's fine to let it lapse and replace it with ` +
    `something you'll actually do). Real people finish what they work at and drop what they don't. ` +
    `(b) Propose up to 2 NEW short-term goals — concrete, specific, achievable in 1-${args.maxNewDays} days — ` +
    `that actually move you toward your long-term aim. Only propose new ones if you have room and a real next step.\n` +
    `Output EXACTLY:\nDONE: <comma-separated numbers of accomplished goals, or: none>\n` +
    `NEW:\n- <goal> | <days from now, 1-${args.maxNewDays}>\n- <goal> | <days>`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 200,
  });
  const doneLine = content.match(/DONE:\s*(.+?)(?:\n|$)/i)?.[1] ?? '';
  const done = /none/i.test(doneLine)
    ? []
    : [...doneLine.matchAll(/\d+/g)].map((m) => parseInt(m[0], 10)).filter((n) => n >= 1);
  const newShorts: { text: string; days: number }[] = [];
  const newSection = content.split(/NEW:/i)[1] ?? '';
  for (const line of newSection.split('\n')) {
    const m = line.match(/^\s*[-*]?\s*(.+?)\s*\|\s*(\d+)/);
    if (m) {
      const text = cleanLine(m[1]);
      const days = clampInt(parseInt(m[2], 10), 1, args.maxNewDays);
      if (text && text.length > 4 && !/^<.*>$/.test(text)) newShorts.push({ text, days });
    }
  }
  return { done: [...new Set(done)], newShorts: newShorts.slice(0, 2) };
}

// v2.1 — a character proposes an OPEN gathering at a place: a title + a one-line invitation, in
// their voice and shaped by what drives them. This is the influence move — a salon, a studio
// open-house, an organizing meeting. Returns null if nothing usable came back.
export async function composeGatheringPitch(args: {
  name: string;
  identity: string;
  beliefs?: Belief[];
  placeName: string;
  driveHint?: string;
}): Promise<{ title: string; blurb: string } | null> {
  const prompt =
    `You are ${args.name}. ${args.identity}\n` +
    beliefBlock(args.beliefs) +
    (args.driveHint ? `What pulls you to bring people together: ${args.driveHint}.\n` : '') +
    `You're going to host an open gathering at ${args.placeName} that anyone in town can come to ` +
    `— the kind of thing someone like you would actually throw (a salon, a workshop, an organizing ` +
    `meeting, a studio open-house, a debate night). Give it a TITLE (under 50 chars) and a single ` +
    `inviting BLURB sentence in your own voice. Make it specific to who you are.\n` +
    `Format EXACTLY:\nTITLE: <title>\nBLURB: <one sentence>`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 110,
  });
  const title = cleanLine(content.match(/TITLE:\s*(.+?)(?:\n|$)/i)?.[1] ?? '').slice(0, 60);
  const blurb = cleanLine(content.match(/BLURB:\s*([\s\S]+?)$/i)?.[1] ?? '').slice(0, 200);
  if (!title) return null;
  return { title, blurb };
}

// v2.3 — FOUNDING a faction. The founder, holding a strong conviction on a charged topic, names an
// informal group/coalition around it, writes a one-line premise in their own voice, and picks which
// of the listed like-minded people they'd invite as allies. The candidates carry a `leaning` hint so
// the model can tell who's actually on their side.
export async function composeFactionFounding(args: {
  name: string;
  identity: string;
  beliefs?: Belief[];
  topic: string;
  poleLabel: string;
  statement: string;
  candidates: { name: string; leaning: string }[];
}): Promise<{ name: string; premise: string; recruits: string[] } | null> {
  const roster = args.candidates.map((c) => `- ${c.name}: ${c.leaning}`).join('\n');
  const prompt =
    `You are ${args.name}. ${args.identity}\n` +
    beliefBlock(args.beliefs) +
    `You feel strongly about ${args.topic} — your side is "${args.poleLabel}". In your words: ` +
    `"${args.statement}"\n` +
    `You've decided to start an informal group in town around this — not a company, just people ` +
    `who see it your way and want to push together. Here's where others seem to stand:\n${roster}\n` +
    `Name the group (short, evocative, NOT corny or corporate — like something real people would ` +
    `actually call themselves), write ONE sentence of premise in your own voice, and list which of ` +
    `those people you'd invite as natural allies (only ones who genuinely share your side).\n` +
    `Format EXACTLY:\nNAME: <group name>\nPREMISE: <one sentence>\nINVITE: <comma-separated names, or none>`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 140,
  });
  const name = cleanLine(content.match(/NAME:\s*(.+?)(?:\n|$)/i)?.[1] ?? '').slice(0, 50);
  const premise = cleanLine(content.match(/PREMISE:\s*(.+?)(?:\n|$)/i)?.[1] ?? '').slice(0, 200);
  const inviteRaw = content.match(/INVITE:\s*(.+?)(?:\n|$)/i)?.[1] ?? '';
  if (!name || !premise) return null;
  const known = new Set(args.candidates.map((c) => c.name));
  const recruits = inviteRaw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter((s) => known.has(s));
  return { name, premise, recruits };
}

// v2.3 — a faction takes a PUBLIC STANCE. The lead speaks for the group: one short, pointed line for
// the town feed that stakes out the faction's position (optionally needling the rival). This is the
// thing members approve or disapprove of — the engine that moves commitment.
export async function composeFactionMove(args: {
  factionName: string;
  premise: string;
  poleLabel: string;
  topic: string;
  leadName: string;
  identity: string;
  rivalName?: string | null;
  hot: boolean; // is the faction running hot right now?
}): Promise<string | null> {
  const prompt =
    `You are ${args.leadName}, speaking FOR the group "${args.factionName}" (${args.premise}). ` +
    `The group stands for "${args.poleLabel}" on ${args.topic}.` +
    (args.rivalName ? ` Your rival in town is "${args.rivalName}".` : '') +
    `\nWrite ONE short public line for the town feed that stakes out where ${args.factionName} ` +
    `stands right now — a rallying line, a call, or a pointed take` +
    (args.rivalName ? ` (you may push back on ${args.rivalName}, but argue the issue, don't just sneer)` : '') +
    `. ${args.hot ? 'The group is fired up — let it show, but stay sharp not cartoonish.' : 'Keep it measured and principled.'} ` +
    `Under 200 characters. No hashtags, no quotation marks. Output only the line.\nStance:`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 110,
    stop: ['\n\n'],
  });
  const stance = cleanLine(content);
  return stance ? stance : null;
}

// v2.4 — GOSSIP. The speaker confides a take about an ABSENT third party to a friend. The line is in
// their own voice, colored by how they actually feel about the subject (feelingHint) and their own
// convictions. Not to the subject's face — this is between the two of them.
export async function composeGossip(args: {
  speakerName: string;
  identity: string;
  beliefs?: Belief[];
  subjectName: string;
  listenerName: string;
  feelingHint: string;
  contextHint?: string; // e.g. "they're in a rival faction" or a recent thing the subject did
}): Promise<string | null> {
  const prompt =
    `You are ${args.speakerName}. ${args.identity}\n` +
    beliefBlock(args.beliefs) +
    `You're talking quietly with your friend ${args.listenerName}, and ${args.subjectName} comes ` +
    `up — they're not here. Your honest read on ${args.subjectName}: ${args.feelingHint}.` +
    (args.contextHint ? ` (${args.contextHint})` : '') +
    `\nSay ONE short, natural thing you'd actually tell a friend about ${args.subjectName} — a ` +
    `candid impression, a confidence, your read on them. It can be warm or critical, but it's the ` +
    `real thing you think, said behind their back, not to their face. Under 200 characters. No ` +
    `quotation marks. Output only the line.\nYou, to ${args.listenerName}:`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 110,
    stop: ['\n\n'],
  });
  const line = cleanLine(content);
  return line ? line : null;
}

// v2.7 — a short, warm note attached to a gift or favor — the kind word that goes with the gesture.
export async function composeReciprocityNote(args: {
  name: string;
  identity: string;
  recipientName: string;
  kind: 'gift' | 'favor';
}): Promise<string | null> {
  const what =
    args.kind === 'gift'
      ? `quietly helping ${args.recipientName} out with some money because they're stretched thin`
      : `doing ${args.recipientName} a small favor`;
  const prompt =
    `You are ${args.name}. ${args.identity}\n` +
    `You're ${what}. Write ONE short, warm, unfussy line to go with it — how you'd actually say it, ` +
    `no big speech, not making it a thing. Under 140 characters. No quotation marks. Output only the line.\n` +
    `You, to ${args.recipientName}:`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 80,
    stop: ['\n\n'],
  });
  const line = cleanLine(content);
  return line ? line : null;
}

// v2.6 — a public CAMPAIGN line on the live civic issue, in the character's own voice and from where
// they stand. This is how a proposition becomes a town argument (posted to the feed).
export async function composeCivicTake(args: {
  name: string;
  identity: string;
  beliefs?: Belief[];
  issueTitle: string;
  issueText: string;
  myStanceLabel: string; // "for the …" / "against the …" / "undecided on the …"
}): Promise<string | null> {
  const prompt =
    `You are ${args.name}. ${args.identity}\n` +
    beliefBlock(args.beliefs) +
    `The town is deciding: ${args.issueTitle} — ${args.issueText}\n` +
    `You are ${args.myStanceLabel}. Write ONE short public line for the town feed making your case ` +
    `— rally people to your side or push back on the other, in your own voice and from what you ` +
    `believe. Argue the substance. Under 200 characters. No hashtags, no quotation marks. Output ` +
    `only the line.\nYour take:`;
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 110,
    stop: ['\n\n'],
  });
  const line = cleanLine(content);
  return line ? line : null;
}
