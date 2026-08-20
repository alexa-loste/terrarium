import { v } from 'convex/values';
import {
  ActionCtx,
  DatabaseReader,
  internalAction,
  internalMutation,
  internalQuery,
} from '../_generated/server';
import { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { LLMMessage, chatCompletion, fetchEmbedding } from '../util/llm';
import { asyncMap } from '../util/asyncMap';
import { GameId, agentId, conversationId, playerId } from '../aiTown/ids';
import { SerializedPlayer } from '../aiTown/player';
import { memoryFields } from './schema';
import { writeJournalEntry } from './journal';

// How long to wait before updating a memory's last access time.
export const MEMORY_ACCESS_THROTTLE = 300_000; // In ms
// We fetch 10x the number of memories by relevance, to have more candidates
// for sorting by relevance + recency + importance.
const MEMORY_OVERFETCH = 10;
const selfInternal = internal.agent.memory;

export type Memory = Doc<'memories'>;
export type MemoryType = Memory['data']['type'];
export type MemoryOfType<T extends MemoryType> = Omit<Memory, 'data'> & {
  data: Extract<Memory['data'], { type: T }>;
};

export async function rememberConversation(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  agentId: GameId<'agents'>,
  playerId: GameId<'players'>,
  conversationId: GameId<'conversations'>,
) {
  const data = await ctx.runQuery(selfInternal.loadConversation, {
    worldId,
    playerId,
    conversationId,
  });
  const { player, otherPlayer } = data;
  const messages = await ctx.runQuery(selfInternal.loadMessages, { worldId, conversationId });
  if (!messages.length) {
    return;
  }

  const llmMessages: LLMMessage[] = [
    {
      role: 'user',
      content: `You are ${player.name}, and you just finished a conversation with ${otherPlayer.name}. ` +
        `In one or two plain sentences, first person ("I"), note what you two actually talked about ` +
        `and where it left things between you. Be factual and brief — no flourish, don't perform ` +
        `your feelings, just what happened and what you took from it.`,
    },
  ];
  const authors = new Set<GameId<'players'>>();
  for (const message of messages) {
    const author = message.author === player.id ? player : otherPlayer;
    authors.add(author.id as GameId<'players'>);
    const recipient = message.author === player.id ? otherPlayer : player;
    llmMessages.push({
      role: 'user',
      content: `${author.name} to ${recipient.name}: ${message.text}`,
    });
  }
  llmMessages.push({ role: 'user', content: 'Summary:' });
  const { content } = await chatCompletion({
    messages: llmMessages,
    max_tokens: 200,
  });
  const description = `Conversation with ${otherPlayer.name} at ${new Date(
    data.conversation._creationTime,
  ).toLocaleString()}: ${content}`;
  const importance = await calculateImportance(description);
  const { embedding } = await fetchEmbedding(description);
  authors.delete(player.id as GameId<'players'>);
  await ctx.runMutation(selfInternal.insertMemory, {
    agentId,
    playerId: player.id,
    description,
    importance,
    lastAccess: messages[messages.length - 1]._creationTime,
    data: {
      type: 'conversation',
      conversationId,
      playerIds: [...authors],
    },
    embedding,
  });
  await reflectOnMemories(ctx, worldId, playerId);
  // Record the gist in the Town Chronicle (v1.3). Rather than reuse a participant's long,
  // performative first-person memory summary, a neutral town-chronicler voice writes a short
  // third-person gist of what happened + how the two now feel about each other. Both
  // participants run this function, so only one side (deterministic by id) writes the entry.
  if (player.id < otherPlayer.id) {
    // Assess the relational shift FIRST so the chronicle gist can be written consistent with it.
    // These were two independent calls and could contradict (gist "grew closer" while the outcome
    // recorded "things cooled"). Now the same warmth/respect/trust deltas drive both.
    const effect = await assessConversation(player, otherPlayer, messages);
    const gist = await narrateConversation(player, otherPlayer, messages, effect);
    await ctx.runMutation(internal.townLog.recordEvent, {
      worldId,
      kind: 'conversation',
      summary: gist,
      playerId: player.id,
      playerName: player.name,
      subjectName: otherPlayer.name,
      emoji: '💬',
    });
    // Update the relationship graph + both social bars from how the conversation landed.
    await ctx.runMutation(internal.relationships.applyConversationOutcome, {
      worldId,
      aPlayerId: player.id,
      aName: player.name,
      bPlayerId: otherPlayer.id,
      bName: otherPlayer.name,
      ...effect,
    });
  }
  // After a conversation that mattered, each side sometimes writes a private journal entry
  // about how it landed (v1.7). Both participants run this, so each journals their own side.
  if (importance >= 6 && Math.random() < 0.35) {
    await writeJournalEntry(ctx, worldId, agentId, playerId, 'conversation', otherPlayer.name);
  }
  return description;
}

// Turn the assessed warmth/respect/trust deltas into a plain directional clause, so the chronicle
// gist describes the SAME shift the relationship graph just recorded — no more "closer" vs "cooled".
function relShiftLabel(e: { warmth: number; respect: number; trust: number }): string {
  const parts: string[] = [];
  if (e.warmth >= 2) parts.push('left them clearly warmer');
  else if (e.warmth === 1) parts.push('left them a little warmer');
  else if (e.warmth <= -2) parts.push('left a real chill between them');
  else if (e.warmth === -1) parts.push('left them slightly cooler');
  if (e.respect >= 2) parts.push('with more respect for each other');
  else if (e.respect <= -2) parts.push('with respect dented');
  if (e.trust <= -2) parts.push('and trust shaken');
  if (!parts.length) return 'left them about where they started — no real change';
  return parts.join(', ');
}

// The town chronicler's voice: a brief, neutral, third-person gist of a finished conversation
// and the relational temperature it left behind. Deliberately NOT first-person or performative.
// The shift is passed in (from assessConversation) so the gist can't contradict the recorded outcome.
async function narrateConversation(
  player: { id: string; name: string },
  otherPlayer: { id: string; name: string },
  messages: Doc<'messages'>[],
  effect: { warmth: number; respect: number; trust: number },
): Promise<string> {
  const transcript = messages
    .map((m) => `${m.author === player.id ? player.name : otherPlayer.name}: ${m.text}`)
    .join('\n');
  const { content } = await chatCompletion({
    messages: [
      {
        role: 'user',
        content:
          `You are the town chronicler, keeping a terse log of life in town. ` +
          `${player.name} and ${otherPlayer.name} just finished this conversation:\n\n${transcript}\n\n` +
          `What it did to them: it ${relShiftLabel(effect)}. ` +
          `Write ONE or TWO short sentences, third person, plainly stating what they talked about ` +
          `and reflecting THAT shift in how they feel about each other — do not contradict it. ` +
          `Be concrete and a little dry. No quotes, no flourish. Under 220 characters.\nLog entry:`,
      },
    ],
    max_tokens: 160,
  });
  const cleaned = content
    .replace(/^\s*(log entry|entry)\s*:?\s*/i, '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .trim();
  // Loose safety net only — let a normal 1-2 sentence gist through whole; trim true runaways.
  return hardCap(cleaned, 360);
}

// The scoring instructions, exported so convex/relationships.ts can run them against fixtures.
// A prompt whose output feeds a numeric state machine is a MEASURABLE component, and this one was
// wrong in production for a long time without anything noticing.
//
// WHAT WENT WRONG (measured 2026-08-20). The previous wording carried three anti-sycophancy
// clauses — "politeness that papered over a real clash isn't warmth", "Don't default to positive",
// and an example whose warmth term was negative — and the small local model read all of it as
// "warmth is negative". It was not ignoring the transcript: a hostile exchange scored -3 and a
// mild one -1, so it was responsive and consistently signed. It just never went positive. An
// unmistakably affectionate conversation — "come by Sunday, I'll cook", "you're one of the few
// people I can be a mess around" — scored warmth -1, four runs out of four at temperature 0.
//
// The consequence was a one-way ratchet. Every conversation in the town cost affinity 4 points and
// nothing ever returned any, so across 56 relationship edges affinity had collapsed to 0 on 43 of
// them and never exceeded 21, while familiarity and respect sat pinned at 100. Everyone knew
// everyone perfectly, respected them completely, and liked none of them. It also silently made
// ROMANCE unreachable, because the romantic term is gated on affinity > 65 — which is how this was
// found: pairing had no signal to consume, and the reason was three sentences in a prompt.
//
// The fix restores symmetry without giving up the intent. The independence clause stays (an honest
// argument still lowers warmth while raising respect); the blanket "don't default to positive" is
// replaced by naming 0 as the honest answer for an exchange that changed nothing, and by saying
// plainly that genuine warmth SHOULD come out positive. The example is now a pair, one of each
// sign, so no single example anchors it.
//
// Verified against relationships:calibrateAssessment — five fixtures, five pass. The old wording
// scores three of the five wrong. Re-run it after ANY edit here, and after changing the model.
export const ASSESS_INSTRUCTIONS =
  `Rate how this conversation changed their relationship on three scales, each a single ` +
  `integer from -3 (much worse) to 3 (much better): warmth (do they like each other more?), ` +
  `respect, and trust. These move independently: a sharp but honest disagreement can LOWER ` +
  `warmth while RAISING respect; politeness that papered over a real clash isn't warmth. ` +
  `The scale is symmetric and 0 is the honest answer for an exchange that changed nothing. ` +
  `Genuine warmth, appreciation, or a repaired rift SHOULD come out positive, just as friction ` +
  `should come out negative. ` +
  `Reply with ONLY three integers separated by spaces — "-1 2 0" for a bruising but clarifying ` +
  `argument, "2 1 1" for two people getting on well.`;

// Rate how a finished conversation moved the two people's relationship: warmth (liking),
// respect (esteem), trust — each a small integer -3..3. One cheap call, parsed leniently so a
// chatty local model can't break it; defaults to neutral on any trouble.
async function assessConversation(
  player: { id: string; name: string },
  otherPlayer: { id: string; name: string },
  messages: Doc<'messages'>[],
): Promise<{ warmth: number; respect: number; trust: number }> {
  const transcript = messages
    .map((m) => `${m.author === player.id ? player.name : otherPlayer.name}: ${m.text}`)
    .join('\n');
  const { content } = await chatCompletion({
    messages: [
      {
        role: 'user',
        content:
          `Here is a conversation between ${player.name} and ${otherPlayer.name}:\n\n${transcript}\n\n` +
          ASSESS_INSTRUCTIONS,
      },
    ],
    temperature: 0,
    max_tokens: 16,
  });
  const nums = (content.match(/-?\d+/g) ?? []).map((n) => Math.max(-3, Math.min(3, parseInt(n, 10))));
  return { warmth: nums[0] ?? 0, respect: nums[1] ?? 0, trust: nums[2] ?? 0 };
}

// Keep chronicle entries scannable even if the local model rambles past the asked length:
// cut at the last sentence end within the cap, else the last word boundary, then ellipsize.
function hardCap(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (lastStop > max * 0.5) return slice.slice(0, lastStop + 1);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > max * 0.5 ? slice.slice(0, lastSpace) : slice).trimEnd() + '…';
}

// v1.2 Step 2 — perception of the town feed.
// When a post is created, it's delivered to every agent's memory stream as an observation,
// exactly like the paper treats perceived events: it then rides the normal retrieval ->
// dialogue path (relatedMemoriesPrompt) and can be referenced in later conversations.
function feedObservation(post: { authorName: string; kind: string; text: string }): string {
  if (post.kind === 'news') return `I saw on the town feed: ${post.text}`;
  if (post.kind === 'research') {
    return `${post.authorName} published research on the town feed: "${post.text}"`;
  }
  return `${post.authorName} posted on the town feed: "${post.text}"`;
}

export const loadFeedDelivery = internalQuery({
  args: { worldId: v.id('worlds'), postId: v.id('feedPosts') },
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.postId);
    if (!post) return null;
    const world = await ctx.db.get(args.worldId);
    if (!world) return null;
    const recipients: { agentId: string; playerId: string }[] = [];
    for (const agent of world.agents) {
      // Don't deliver a post back to its own author (agent posting comes in Step 3).
      if (post.authorPlayerId && agent.playerId === post.authorPlayerId) continue;
      recipients.push({ agentId: agent.id, playerId: agent.playerId });
    }
    return {
      post: { authorName: post.authorName, kind: post.kind, text: post.text },
      recipients,
    };
  },
});

export const deliverFeedPost = internalAction({
  args: { worldId: v.id('worlds'), postId: v.id('feedPosts') },
  handler: async (ctx, args) => {
    const data = await ctx.runQuery(selfInternal.loadFeedDelivery, args);
    if (!data || data.recipients.length === 0) return;
    const description = feedObservation(data.post);
    // Importance + embedding are identical across recipients, so compute once.
    const importance = await calculateImportance(description);
    const { embedding } = await fetchEmbedding(description);
    const now = Date.now();
    for (const r of data.recipients) {
      await ctx.runMutation(selfInternal.insertMemory, {
        agentId: r.agentId as GameId<'agents'>,
        playerId: r.playerId as GameId<'players'>,
        description,
        importance,
        lastAccess: now,
        data: { type: 'feedPost', postId: args.postId },
        embedding,
      });
    }
  },
});

export const loadDmDelivery = internalQuery({
  args: { worldId: v.id('worlds'), messageId: v.id('directMessages') },
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.messageId);
    if (!msg) return null;
    const world = await ctx.db.get(args.worldId);
    if (!world) return null;
    // Only deliver to memory if the recipient is an agent (skip human players).
    const agent = world.agents.find((a) => a.playerId === msg.toPlayerId);
    if (!agent) return null;
    return { agentId: agent.id, toPlayerId: msg.toPlayerId, fromName: msg.fromName, text: msg.text };
  },
});

export const deliverDirectMessage = internalAction({
  args: { worldId: v.id('worlds'), messageId: v.id('directMessages') },
  handler: async (ctx, args) => {
    const d = await ctx.runQuery(selfInternal.loadDmDelivery, args);
    if (!d) return;
    const description = `${d.fromName} sent me a direct message: "${d.text}"`;
    const importance = await calculateImportance(description);
    const { embedding } = await fetchEmbedding(description);
    await ctx.runMutation(selfInternal.insertMemory, {
      agentId: d.agentId as GameId<'agents'>,
      playerId: d.toPlayerId as GameId<'players'>,
      description,
      importance,
      lastAccess: Date.now(),
      data: { type: 'directMessage', messageId: args.messageId },
      embedding,
    });
  },
});

export const loadConversation = internalQuery({
  args: {
    worldId: v.id('worlds'),
    playerId,
    conversationId,
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`World ${args.worldId} not found`);
    }
    const player = world.players.find((p) => p.id === args.playerId);
    if (!player) {
      throw new Error(`Player ${args.playerId} not found`);
    }
    const playerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    if (!playerDescription) {
      throw new Error(`Player description for ${args.playerId} not found`);
    }
    const conversation = await ctx.db
      .query('archivedConversations')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('id', args.conversationId))
      .first();
    if (!conversation) {
      throw new Error(`Conversation ${args.conversationId} not found`);
    }
    const otherParticipator = await ctx.db
      .query('participatedTogether')
      .withIndex('conversation', (q) =>
        q
          .eq('worldId', args.worldId)
          .eq('player1', args.playerId)
          .eq('conversationId', args.conversationId),
      )
      .first();
    if (!otherParticipator) {
      throw new Error(
        `Couldn't find other participant in conversation ${args.conversationId} with player ${args.playerId}`,
      );
    }
    const otherPlayerId = otherParticipator.player2;
    let otherPlayer: SerializedPlayer | Doc<'archivedPlayers'> | null =
      world.players.find((p) => p.id === otherPlayerId) ?? null;
    if (!otherPlayer) {
      otherPlayer = await ctx.db
        .query('archivedPlayers')
        .withIndex('worldId', (q) => q.eq('worldId', world._id).eq('id', otherPlayerId))
        .first();
    }
    if (!otherPlayer) {
      throw new Error(`Conversation ${args.conversationId} other player not found`);
    }
    const otherPlayerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', otherPlayerId))
      .first();
    if (!otherPlayerDescription) {
      throw new Error(`Player description for ${otherPlayerId} not found`);
    }
    return {
      player: { ...player, name: playerDescription.name },
      conversation,
      otherPlayer: { ...otherPlayer, name: otherPlayerDescription.name },
    };
  },
});

export async function searchMemories(
  ctx: ActionCtx,
  playerId: GameId<'players'>,
  searchEmbedding: number[],
  n: number = 3,
) {
  const candidates = await ctx.vectorSearch('memoryEmbeddings', 'embedding', {
    vector: searchEmbedding,
    filter: (q) => q.eq('playerId', playerId),
    limit: n * MEMORY_OVERFETCH,
  });
  const rankedMemories = await ctx.runMutation(selfInternal.rankAndTouchMemories, {
    candidates,
    n,
  });
  return rankedMemories.map(({ memory }) => memory);
}

function makeRange(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return [min, max] as const;
}

function normalize(value: number, range: readonly [number, number]) {
  const [min, max] = range;
  return (value - min) / (max - min);
}

export const rankAndTouchMemories = internalMutation({
  args: {
    candidates: v.array(v.object({ _id: v.id('memoryEmbeddings'), _score: v.number() })),
    n: v.number(),
  },
  handler: async (ctx, args) => {
    const ts = Date.now();
    const relatedMemories = await asyncMap(args.candidates, async ({ _id }) => {
      const memory = await ctx.db
        .query('memories')
        .withIndex('embeddingId', (q) => q.eq('embeddingId', _id))
        .first();
      if (!memory) throw new Error(`Memory for embedding ${_id} not found`);
      return memory;
    });

    // TODO: fetch <count> recent memories and <count> important memories
    // so we don't miss them in case they were a little less relevant.
    const recencyScore = relatedMemories.map((memory) => {
      const hoursSinceAccess = (ts - memory.lastAccess) / 1000 / 60 / 60;
      return 0.99 ** Math.floor(hoursSinceAccess);
    });
    const relevanceRange = makeRange(args.candidates.map((c) => c._score));
    const importanceRange = makeRange(relatedMemories.map((m) => m.importance));
    const recencyRange = makeRange(recencyScore);
    const memoryScores = relatedMemories.map((memory, idx) => ({
      memory,
      overallScore:
        normalize(args.candidates[idx]._score, relevanceRange) +
        normalize(memory.importance, importanceRange) +
        normalize(recencyScore[idx], recencyRange),
    }));
    memoryScores.sort((a, b) => b.overallScore - a.overallScore);
    const accessed = memoryScores.slice(0, args.n);
    await asyncMap(accessed, async ({ memory }) => {
      if (memory.lastAccess < ts - MEMORY_ACCESS_THROTTLE) {
        await ctx.db.patch(memory._id, { lastAccess: ts });
      }
    });
    return accessed;
  },
});

export const loadMessages = internalQuery({
  args: {
    worldId: v.id('worlds'),
    conversationId,
  },
  handler: async (ctx, args): Promise<Doc<'messages'>[]> => {
    const messages = await ctx.db
      .query('messages')
      .withIndex('conversationId', (q) =>
        q.eq('worldId', args.worldId).eq('conversationId', args.conversationId),
      )
      .collect();
    return messages;
  },
});

async function calculateImportance(description: string) {
  const { content: importanceRaw } = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: `On the scale of 0 to 9, where 0 is purely mundane (e.g., brushing teeth, making bed) and 9 is extremely poignant (e.g., a break up, college acceptance), rate the likely poignancy of the following piece of memory.
      Memory: ${description}
      Answer on a scale of 0 to 9. Respond with number only, e.g. "5"`,
      },
    ],
    temperature: 0.0,
    // Was 1, but some local models (e.g. deepseek-v2) preface the digit with a word, so a
    // 1-token cap yields no number and importance silently falls back to a constant. A few
    // tokens lets the digit appear; the regex below extracts it. Llama still answers tersely.
    max_tokens: 6,
  });

  let importance = parseFloat(importanceRaw);
  if (isNaN(importance)) {
    importance = +(importanceRaw.match(/\d+/)?.[0] ?? NaN);
  }
  if (isNaN(importance)) {
    console.debug('Could not parse memory importance from: ', importanceRaw);
    importance = 5;
  }
  return importance;
}

const { embeddingId: _embeddingId, ...memoryFieldsWithoutEmbeddingId } = memoryFields;

export const insertMemory = internalMutation({
  args: {
    agentId,
    embedding: v.array(v.float64()),
    ...memoryFieldsWithoutEmbeddingId,
  },
  handler: async (ctx, { agentId: _, embedding, ...memory }): Promise<void> => {
    const embeddingId = await ctx.db.insert('memoryEmbeddings', {
      playerId: memory.playerId,
      embedding,
    });
    await ctx.db.insert('memories', {
      ...memory,
      embeddingId,
    });
  },
});

export const insertReflectionMemories = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    reflections: v.array(
      v.object({
        description: v.string(),
        relatedMemoryIds: v.array(v.id('memories')),
        importance: v.number(),
        embedding: v.array(v.float64()),
      }),
    ),
  },
  handler: async (ctx, { playerId, reflections }) => {
    const lastAccess = Date.now();
    for (const { embedding, relatedMemoryIds, ...rest } of reflections) {
      const embeddingId = await ctx.db.insert('memoryEmbeddings', {
        playerId,
        embedding,
      });
      await ctx.db.insert('memories', {
        playerId,
        embeddingId,
        lastAccess,
        ...rest,
        data: {
          type: 'reflection',
          relatedMemoryIds,
        },
      });
    }
  },
});

export async function reflectOnMemories(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  playerId: GameId<'players'>,
) {
  const { memories, lastReflectionTs, name } = await ctx.runQuery(
    internal.agent.memory.getReflectionMemories,
    {
      worldId,
      playerId,
      numberOfItems: 100,
    },
  );

  // should only reflect if lastest 100 items have importance score of >500
  const sumOfImportanceScore = memories
    .filter((m) => m._creationTime > (lastReflectionTs ?? 0))
    .reduce((acc, curr) => acc + curr.importance, 0);
  const shouldReflect = sumOfImportanceScore > 500;

  if (!shouldReflect) {
    return false;
  }
  console.debug('sum of importance score = ', sumOfImportanceScore);
  console.debug('Reflecting...');
  const prompt = ['[no prose]', '[Output only JSON]', `You are ${name}, statements about you:`];
  memories.forEach((m, idx) => {
    prompt.push(`Statement ${idx}: ${m.description}`);
  });
  prompt.push('What 3 high-level insights can you infer from the above statements?');
  prompt.push(
    'Return in JSON format, where the key is a list of input statements that contributed to your insights and value is your insight. Make the response parseable by Typescript JSON.parse() function. DO NOT escape characters or include "\n" or white space in response.',
  );
  prompt.push(
    'Example: [{insight: "...", statementIds: [1,2]}, {insight: "...", statementIds: [1]}, ...]',
  );

  const { content: reflection } = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: prompt.join('\n'),
      },
    ],
  });

  try {
    const insights = JSON.parse(reflection) as { insight: string; statementIds: number[] }[];
    const memoriesToSave = await asyncMap(insights, async (item) => {
      const relatedMemoryIds = item.statementIds.map((idx: number) => memories[idx]._id);
      const importance = await calculateImportance(item.insight);
      const { embedding } = await fetchEmbedding(item.insight);
      console.debug('adding reflection memory...', item.insight);
      return {
        description: item.insight,
        embedding,
        importance,
        relatedMemoryIds,
      };
    });

    await ctx.runMutation(selfInternal.insertReflectionMemories, {
      worldId,
      playerId,
      reflections: memoriesToSave,
    });
  } catch (e) {
    console.error('error saving or parsing reflection', e);
    console.debug('reflection', reflection);
    return false;
  }
  return true;
}
export const getReflectionMemories = internalQuery({
  args: { worldId: v.id('worlds'), playerId, numberOfItems: v.number() },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`World ${args.worldId} not found`);
    }
    const player = world.players.find((p) => p.id === args.playerId);
    if (!player) {
      throw new Error(`Player ${args.playerId} not found`);
    }
    const playerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    if (!playerDescription) {
      throw new Error(`Player description for ${args.playerId} not found`);
    }
    const memories = await ctx.db
      .query('memories')
      .withIndex('playerId', (q) => q.eq('playerId', player.id))
      .order('desc')
      .take(args.numberOfItems);

    const lastReflection = await ctx.db
      .query('memories')
      .withIndex('playerId_type', (q) =>
        q.eq('playerId', args.playerId).eq('data.type', 'reflection'),
      )
      .order('desc')
      .first();

    return {
      name: playerDescription.name,
      memories,
      lastReflectionTs: lastReflection?._creationTime,
    };
  },
});

export async function latestMemoryOfType<T extends MemoryType>(
  db: DatabaseReader,
  playerId: GameId<'players'>,
  type: T,
) {
  const entry = await db
    .query('memories')
    .withIndex('playerId_type', (q) => q.eq('playerId', playerId).eq('data.type', type))
    .order('desc')
    .first();
  if (!entry) return null;
  return entry as MemoryOfType<T>;
}
