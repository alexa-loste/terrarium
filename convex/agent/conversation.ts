import { v } from 'convex/values';
import { Id } from '../_generated/dataModel';
import { ActionCtx, internalQuery } from '../_generated/server';
import {
  LLMMessage,
  chatCompletion,
  looksLikeMeta,
  stripMetaCommentary,
  stripNarration,
} from '../util/llm';
import * as memory from './memory';
import { api, internal } from '../_generated/api';
import * as embeddingsCache from './embeddingsCache';
import { GameId, conversationId, playerId } from '../aiTown/ids';
import { MAX_PROMPT_MESSAGES, NUM_MEMORIES_TO_SEARCH } from '../constants';
import { nearestPlace } from '../../data/places';
import { timeOfDayPrompt, WorldTime } from '../../data/clock';
import { planWhenLabel } from '../../data/plans';
import { moodPromptLine } from '../../data/mood';
import {
  LifeStage,
  ageOn,
  identityAtAge,
  identityStatesAge,
  othersSeeStage,
  stageFor,
  stagePromptLine,
} from '../../data/lifecycle';
import { worldTimeNow } from '../clock';
import { getLifecycle } from '../lifecycle';

const selfInternal = internal.agent.conversation;

export async function startConversationMessage(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
): Promise<string> {
  const { player, otherPlayer, place, agent, otherAgent, lastConversation , life, otherLife } = await ctx.runQuery(
    selfInternal.queryPromptData,
    {
      worldId,
      playerId,
      otherPlayerId,
      conversationId,
    },
  );
  const embedding = await embeddingsCache.fetch(
    ctx,
    `${player.name} is talking to ${otherPlayer.name}`,
  );

  const memories = await memory.searchMemories(
    ctx,
    player.id as GameId<'players'>,
    embedding,
    Number(process.env.NUM_MEMORIES_TO_SEARCH) || NUM_MEMORIES_TO_SEARCH,
  );

  const memoryWithOtherPlayer = memories.find(
    (m) => m.data.type === 'conversation' && m.data.playerIds.includes(otherPlayerId),
  );
  const time: WorldTime = await ctx.runQuery(internal.clock.currentTime, { worldId });
  const beliefs = await ctx.runQuery(internal.beliefs.forContext, { worldId, playerId });
  const plans = await ctx.runQuery(internal.plans.upcomingForPlayer, {
    worldId,
    playerId,
    currentDay: time.day,
  });
  const innerState = await loadInnerState(ctx, worldId, playerId, time.day);
  const heard = await ctx.runQuery(internal.gossip.heardAbout, {
    worldId,
    listenerPlayerId: playerId,
    subjectPlayerId: otherPlayerId,
  });
  const edge = await ctx.runQuery(internal.relationships.edgeFor, {
    worldId,
    fromPlayerId: playerId,
    toPlayerId: otherPlayerId,
  });
  const prompt = [
    `You are ${player.name}, and you just started a conversation with ${otherPlayer.name}.`,
    timeOfDayPrompt(time),
  ];
  if (place) prompt.push(`You're at ${place}.`);
  prompt.push(...agentPrompts(otherPlayer, agent, otherAgent ?? null));
  prompt.push(...agePrompt(life, agent?.identity, otherPlayer.name, otherLife));
  prompt.push(...relationshipPrompt(otherPlayer.name, edge));
  prompt.push(...beliefsPrompt(beliefs));
  prompt.push(...innerStatePrompt(innerState.vit, innerState.goals, innerState.drives, time.day));
  prompt.push(...factionPrompt(innerState.faction));
  prompt.push(...civicPrompt(innerState.civic));
  prompt.push(...reciprocityPrompt(innerState.ledger, otherPlayer.name));
  prompt.push(...gossipHintPrompt(heard, otherPlayer.name));
  prompt.push(...plansPrompt(plans, time.day, player.name));
  prompt.push(...previousConversationPrompt(otherPlayer, lastConversation));
  prompt.push(...relatedMemoriesPrompt(memories));
  prompt.push(...dialogueStyle(player.name, otherPlayer.name));
  if (memoryWithOtherPlayer) {
    prompt.push(
      `You and ${otherPlayer.name} have talked before. Do NOT recap, rehash, or reminisce about ` +
        `those past chats — open with something new: a fresh thought, a reaction to what's ` +
        `happening right now, or a question you haven't asked them yet.`,
    );
  }
  const lastPrompt = `${player.name} to ${otherPlayer.name}:`;
  prompt.push(lastPrompt);

  return completeDialogue(
    [{ role: 'system', content: prompt.join('\n') }],
    lastPrompt,
    stopWords(otherPlayer.name, player.name),
  );
}

function trimContentPrefx(content: string, prompt: string) {
  let c = content;
  if (c.startsWith(prompt)) {
    c = c.slice(prompt.length).trim();
  }
  // Strip leaked meta prefixes the small local model sometimes emits, e.g.
  // "Naomi's response would be: ..." or "Theo would say: ...".
  c = c.replace(
    /^\s*[A-Z][a-z]+(?:'s)?\s+(?:response would be|would say|says|replies?)\s*:?\s*/i,
    '',
  );
  // And the heavier leak where it narrates the task ("Task Summary: …") instead of speaking.
  c = stripMetaCommentary(c);
  // And the novelization leak where it quotes its own speech + adds prose stage-directions
  // ('"…," I concede, my gaze skeptical. "…"') instead of just speaking.
  c = stripNarration(c);
  return c.trim();
}

// The small local model occasionally breaks character and describes the task instead of speaking
// the line (the "Task Summary: … Guidelines Met in Response: …" leak). Generate, and if what comes
// back is task-narration (or empty after stripping), re-ask ONCE with a sterner corrective before
// falling back to the stripped text. Keeps narration out of the transcript.
async function completeDialogue(
  messages: LLMMessage[],
  lastPrompt: string,
  stop: string[],
): Promise<string> {
  const { content } = await chatCompletion({ messages, max_tokens: 300, stop });
  if (!looksLikeMeta(content)) return trimContentPrefx(content, lastPrompt);
  const retryMessages: LLMMessage[] = [
    ...messages,
    {
      role: 'system',
      content:
        'You broke character and described the task instead of speaking. Do NOT write any ' +
        'summary, preamble, label, or meta-commentary. Reply with ONLY the single line of ' +
        'dialogue, in the first person, and nothing else.',
    },
    { role: 'user', content: lastPrompt },
  ];
  const retry = await chatCompletion({ messages: retryMessages, max_tokens: 240, stop });
  // Use whichever attempt yields real in-character text; trimContentPrefx strips any residue.
  const cleaned = trimContentPrefx(retry.content, lastPrompt);
  return cleaned || trimContentPrefx(content, lastPrompt);
}

export async function continueConversationMessage(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
): Promise<string> {
  const { player, otherPlayer, place, conversation, agent, otherAgent , life, otherLife } = await ctx.runQuery(
    selfInternal.queryPromptData,
    {
      worldId,
      playerId,
      otherPlayerId,
      conversationId,
    },
  );
  const embedding = await embeddingsCache.fetch(
    ctx,
    `What do you think about ${otherPlayer.name}?`,
  );
  const memories = await memory.searchMemories(ctx, player.id as GameId<'players'>, embedding, 3);
  const time: WorldTime = await ctx.runQuery(internal.clock.currentTime, { worldId });
  const beliefs = await ctx.runQuery(internal.beliefs.forContext, { worldId, playerId });
  const plans = await ctx.runQuery(internal.plans.upcomingForPlayer, {
    worldId,
    playerId,
    currentDay: time.day,
  });
  const innerState = await loadInnerState(ctx, worldId, playerId, time.day);
  const heard = await ctx.runQuery(internal.gossip.heardAbout, {
    worldId,
    listenerPlayerId: playerId,
    subjectPlayerId: otherPlayerId,
  });
  const edge = await ctx.runQuery(internal.relationships.edgeFor, {
    worldId,
    fromPlayerId: playerId,
    toPlayerId: otherPlayerId,
  });
  const prompt = [
    `You are ${player.name}, and you're currently in a conversation with ${otherPlayer.name}.`,
    timeOfDayPrompt(time),
  ];
  if (place) prompt.push(`You're at ${place}.`);
  prompt.push(...agentPrompts(otherPlayer, agent, otherAgent ?? null));
  prompt.push(...agePrompt(life, agent?.identity, otherPlayer.name, otherLife));
  prompt.push(...relationshipPrompt(otherPlayer.name, edge));
  prompt.push(...beliefsPrompt(beliefs));
  prompt.push(...innerStatePrompt(innerState.vit, innerState.goals, innerState.drives, time.day));
  prompt.push(...factionPrompt(innerState.faction));
  prompt.push(...civicPrompt(innerState.civic));
  prompt.push(...reciprocityPrompt(innerState.ledger, otherPlayer.name));
  prompt.push(...gossipHintPrompt(heard, otherPlayer.name));
  prompt.push(...plansPrompt(plans, time.day, player.name));
  prompt.push(...relatedMemoriesPrompt(memories));
  prompt.push(
    `Below is the current chat history between you and ${otherPlayer.name}.`,
    `DO NOT greet them again. Do NOT use the word "Hey" too often. Your response should be brief and within 200 characters.`,
  );
  prompt.push(...dialogueStyle(player.name, otherPlayer.name));

  const llmMessages: LLMMessage[] = [
    {
      role: 'system',
      content: prompt.join('\n'),
    },
    ...(await previousMessages(
      ctx,
      worldId,
      player,
      otherPlayer,
      conversation.id as GameId<'conversations'>,
    )),
  ];
  const lastPrompt = `${player.name} to ${otherPlayer.name}:`;
  llmMessages.push({ role: 'user', content: lastPrompt });

  return completeDialogue(llmMessages, lastPrompt, stopWords(otherPlayer.name, player.name));
}

export async function leaveConversationMessage(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
): Promise<string> {
  const { player, otherPlayer, conversation, agent, otherAgent , life, otherLife } = await ctx.runQuery(
    selfInternal.queryPromptData,
    {
      worldId,
      playerId,
      otherPlayerId,
      conversationId,
    },
  );
  const prompt = [
    `You are ${player.name}, and you're currently in a conversation with ${otherPlayer.name}.`,
    `You've decided to leave the question and would like to politely tell them you're leaving the conversation.`,
  ];
  prompt.push(...agentPrompts(otherPlayer, agent, otherAgent ?? null));
  prompt.push(...agePrompt(life, agent?.identity, otherPlayer.name, otherLife));
  prompt.push(
    `Below is the current chat history between you and ${otherPlayer.name}.`,
    `How would you like to tell them that you're leaving? Your response should be brief and within 200 characters.`,
  );
  prompt.push(...dialogueStyle(player.name, otherPlayer.name));
  const llmMessages: LLMMessage[] = [
    {
      role: 'system',
      content: prompt.join('\n'),
    },
    ...(await previousMessages(
      ctx,
      worldId,
      player,
      otherPlayer,
      conversation.id as GameId<'conversations'>,
    )),
  ];
  const lastPrompt = `${player.name} to ${otherPlayer.name}:`;
  llmMessages.push({ role: 'user', content: lastPrompt });

  return completeDialogue(llmMessages, lastPrompt, stopWords(otherPlayer.name, player.name));
}

function agentPrompts(
  otherPlayer: { name: string },
  agent: { identity: string; plan: string } | null,
  otherAgent: { identity: string; plan: string } | null,
): string[] {
  const prompt = [];
  if (agent) {
    prompt.push(`Who you are: ${agent.identity}`);
    prompt.push(`What you want right now: ${agent.plan}`);
  }
  if (otherAgent) {
    prompt.push(`About ${otherPlayer.name}, in their own words: ${otherAgent.identity}`);
  }
  return prompt;
}

// v1.8 — put the speaker's convictions in front of them so dialogue argues from real positions
// (and they're not afraid to disagree). Only the strong ones; loosely-held ones stay quiet.
function beliefsPrompt(beliefs: { statement: string; conviction: number }[] | null): string[] {
  const strong = (beliefs ?? []).filter((b) => b.conviction >= 45).slice(0, 3);
  if (!strong.length) return [];
  return [
    `What you believe (speak from these; push back honestly if they say something you disagree with):\n- ` +
      strong.map((b) => b.statement).join('\n- '),
  ];
}

// v2.8 — how the speaker actually FEELS about the person in front of them, in plain language. This
// was the real gap: they talked to everyone blind to their own affinity/respect/trust. We just
// state the feeling and let the model carry it — no tone-scripting.
function relationshipPrompt(
  otherName: string,
  edge: { affinity: number; respect: number; trust: number } | null,
): string[] {
  if (!edge) return [];
  const clauses: string[] = [];
  if (edge.affinity >= 70) clauses.push(`you genuinely like them`);
  else if (edge.affinity >= 57) clauses.push(`you're warm toward them`);
  else if (edge.affinity <= 30) clauses.push(`there's real friction between you`);
  else if (edge.affinity <= 43) clauses.push(`you're a bit cool toward them`);
  if (edge.respect <= 33) clauses.push(`you don't much respect how they carry themselves`);
  else if (edge.respect >= 72) clauses.push(`you respect them`);
  if (edge.trust <= 33) clauses.push(`you don't fully trust them`);
  if (!clauses.length) return [];
  return [`How you feel about ${otherName}: ${clauses.join('; ')}.`];
}

// v2.0 — put any gatherings coming up soon in front of the speaker, so they bring them up,
// coordinate the details, or remember to show up. These are SHARED rows both people see, which
// is what keeps the two sides of a plan on the same page.
function plansPrompt(
  plans:
    | { title: string; day: number; hour?: number; placeName?: string; attendees: string[] }[]
    | null,
  currentDay: number,
  selfName: string,
): string[] {
  if (!plans || !plans.length) return [];
  const lines = plans.map((p) => {
    const when = planWhenLabel(p.day, currentDay, p.hour);
    const where = p.placeName ? ` at ${p.placeName}` : '';
    const others = p.attendees.filter((n) => n !== selfName);
    const withWho = others.length ? ` with ${others.join(' and ')}` : '';
    return `- ${p.title}${where}, ${when}${withWho}`;
  });
  return [
    `Plans you've already made (these are real commitments — bring them up, sort out details, ` +
      `or look forward to them):\n${lines.join('\n')}`,
  ];
}

// Fetch the three inner-state pieces (mood vitals, goal ladder, top drives) in one place.
async function loadInnerState(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  playerId: GameId<'players'>,
  currentDay: number,
) {
  const vit = await ctx.runQuery(internal.agentVitals.getVitals, { worldId, playerId });
  const goals = await ctx.runQuery(internal.goals.activeForPlayer, {
    worldId,
    playerId,
    currentDay,
  });
  const drives = await ctx.runQuery(internal.drives.topForPlayer, { worldId, playerId });
  const faction = await ctx.runQuery(internal.factions.forPlayer, { worldId, playerId });
  const civic = await ctx.runQuery(internal.civics.issueForPlayer, { worldId, playerId });
  const ledger = await ctx.runQuery(internal.reciprocity.ledgerForPlayer, { worldId, playerId });
  return { vit, goals, drives, faction, civic, ledger };
}

// v2.7 — money between you and the person in front of you: a debt you owe them (a little awkward) or
// one they owe you (quietly on your mind). Only surfaces the tie to THIS other person.
function reciprocityPrompt(
  ledger: { owe: { name: string; amount: number }[]; owed: { name: string; amount: number }[] } | null,
  otherName: string,
): string[] {
  if (!ledger) return [];
  const iOwe = ledger.owe.find((o) => o.name === otherName);
  const theyOwe = ledger.owed.find((o) => o.name === otherName);
  const out: string[] = [];
  if (iOwe) out.push(`You still owe ${otherName} ${iOwe.amount} — it's a little awkward, in the back of your mind.`);
  if (theyOwe) out.push(`${otherName} still owes you ${theyOwe.amount}; you haven't pressed it, but you know.`);
  return out;
}

// v2.6 — the live town vote, if one's running, and where this character stands. Makes the civic
// stakes show up in how they talk while a campaign is on.
function civicPrompt(
  civic: { title: string; text: string; myStanceLabel: string } | null,
): string[] {
  if (!civic) return [];
  return [
    `The town is deciding: ${civic.title} — ${civic.text} You are ${civic.myStanceLabel}; if it ` +
      `comes up, speak from where you stand.`,
  ];
}

// v2.3 — the character's allegiance, so the fault lines show up in how they argue. Their faction
// and where it stands, who they stand with, and the rival across the line. The guardrail wording
// keeps this from turning into scripted hostility — a difference in view, not an order to attack.
function factionPrompt(
  faction: {
    name: string;
    premise: string;
    poleLabel: string;
    members: string[];
    rival: { name: string; premise: string } | null;
    drawnToward: string[];
  } | null,
): string[] {
  if (!faction) return [];
  const out: string[] = [];
  let line = `You stand with ${faction.name} — ${faction.premise} (you're on the side of ${faction.poleLabel}).`;
  if (faction.members.length) line += ` Others in it: ${faction.members.slice(0, 4).join(', ')}.`;
  out.push(line);
  if (faction.rival) {
    out.push(
      `Across the line is ${faction.rival.name}, who believe ${faction.rival.premise}. You see it ` +
        `differently and it shows when it comes up — but argue the substance, don't just be hostile.`,
    );
  }
  if (faction.drawnToward.length) {
    out.push(`You're also drawn to ${faction.drawnToward.slice(0, 2).join(' and ')}.`);
  }
  return out;
}

// v2.4 — secondhand impression: the latest thing you've heard about the person in front of you, from
// someone else. It colors your guard, but you still judge them on how they actually show up.
function gossipHintPrompt(
  heard: { speakerName: string; line: string; valence: number } | null,
  otherName: string,
): string[] {
  if (!heard) return [];
  return [
    `Something colors how you see ${otherName}: ${heard.speakerName} told you, about them, "${heard.line}" ` +
      `You haven't forgotten it — but judge ${otherName} on how they actually are with you now.`,
  ];
}

// v2.1 — the speaker's inner state: what drives them, what they're working toward (long-term +
// the live milestones with deadlines), and the mood that's rolled up from their needs, goal
// progress, and standing. This is what makes the stakes show up in how they talk — a stressed
// character behind on a goal carries themselves differently than one whose work is clicking.
function innerStatePrompt(
  vit: { stress?: number; momentum?: number } | null,
  goals: { long: { text: string } | null; shorts: { text: string; daysLeft: number }[] } | null,
  drives: { label: string }[] | null,
  _currentDay: number,
): string[] {
  const out: string[] = [];
  if (drives && drives.length) {
    out.push(
      `What drives you, underneath it all: ${drives
        .slice(0, 2)
        .map((d) => d.label)
        .join('; ')}.`,
    );
  }
  if (goals?.long) {
    const shorts = (goals.shorts ?? [])
      .slice(0, 2)
      .map((s) => `${s.text} (${s.daysLeft <= 0 ? 'overdue' : `${s.daysLeft}d left`})`);
    out.push(
      `What you're working toward: ${goals.long.text}` +
        (shorts.length ? ` Right now you're pushing on: ${shorts.join('; ')}.` : ''),
    );
  }
  if (vit) {
    const line = moodPromptLine(vit.stress ?? 25, vit.momentum ?? 50);
    if (line) out.push(line);
  }
  return out;
}

// Keep the (small, local) model from writing the other person's lines or stage directions.
function dialogueStyle(playerName: string, otherName: string): string[] {
  return [
    `Reply with ONE short line of dialogue spoken by ${playerName}, in the first person.`,
    `Don't repeat a point you or ${otherName} has already made in this chat — add something new. ` +
      `If the exchange has run its course, say a natural closing line instead of restating it.`,
    `Do NOT write ${otherName}'s reply. Do NOT narrate actions or use stage directions or` +
      ` parentheticals like "(skeptical)" or "(starts typing)". Just say the line out loud.`,
  ];
}

function previousConversationPrompt(
  otherPlayer: { name: string },
  conversation: { created: number } | null,
): string[] {
  const prompt = [];
  if (conversation) {
    const prev = new Date(conversation.created);
    const now = new Date();
    prompt.push(
      `Last time you chatted with ${
        otherPlayer.name
      } it was ${prev.toLocaleString()}. It's now ${now.toLocaleString()}.`,
    );
  }
  return prompt;
}

function relatedMemoriesPrompt(memories: memory.Memory[]): string[] {
  const prompt = [];
  if (memories.length > 0) {
    prompt.push(`Here are some related memories in decreasing relevance order:`);
    for (const memory of memories) {
      prompt.push(' - ' + memory.description);
    }
  }
  return prompt;
}

async function previousMessages(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  player: { id: string; name: string },
  otherPlayer: { id: string; name: string },
  conversationId: GameId<'conversations'>,
) {
  const llmMessages: LLMMessage[] = [];
  const all = await ctx.runQuery(api.messages.listMessages, { worldId, conversationId });
  // Only the tail. `listMessages` collects the WHOLE conversation and stays uncapped on purpose —
  // the UI shows the full transcript — but feeding all of it back into every prompt is a runaway:
  // each message makes the next generation slower, and past ACTION_TIMEOUT the engine gives up on
  // the operation while the model is still writing. See MAX_PROMPT_MESSAGES for the incident.
  const prevMessages = all.slice(-MAX_PROMPT_MESSAGES);
  for (const message of prevMessages) {
    const author = message.author === player.id ? player : otherPlayer;
    const recipient = message.author === player.id ? otherPlayer : player;
    llmMessages.push({
      role: 'user',
      content: `${author.name} to ${recipient.name}: ${message.text}`,
    });
  }
  return llmMessages;
}

// A friendly "where am I" label for the prompt: the agent's own home reads as "home",
// any other place reads by name, open ground reads as nothing.
function placeLabel(
  player: { position?: { x: number; y: number } },
  characterName: string,
): string | null {
  const pos = player.position;
  if (!pos) return null;
  const place = nearestPlace(pos.x, pos.y);
  if (!place) return null;
  if (place.type === 'home') {
    return place.owner === characterName ? 'home' : place.name;
  }
  return place.name;
}

export const queryPromptData = internalQuery({
  args: {
    worldId: v.id('worlds'),
    playerId,
    otherPlayerId: playerId,
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
    const otherPlayer = world.players.find((p) => p.id === args.otherPlayerId);
    if (!otherPlayer) {
      throw new Error(`Player ${args.otherPlayerId} not found`);
    }
    const otherPlayerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.otherPlayerId))
      .first();
    if (!otherPlayerDescription) {
      throw new Error(`Player description for ${args.otherPlayerId} not found`);
    }
    const conversation = world.conversations.find((c) => c.id === args.conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${args.conversationId} not found`);
    }
    const agent = world.agents.find((a) => a.playerId === args.playerId);
    if (!agent) {
      throw new Error(`Player ${args.playerId} not found`);
    }
    const agentDescription = await ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('agentId', agent.id))
      .first();
    if (!agentDescription) {
      throw new Error(`Agent description for ${agent.id} not found`);
    }
    const otherAgent = world.agents.find((a) => a.playerId === args.otherPlayerId);
    let otherAgentDescription;
    if (otherAgent) {
      otherAgentDescription = await ctx.db
        .query('agentDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('agentId', otherAgent.id))
        .first();
      if (!otherAgentDescription) {
        throw new Error(`Agent description for ${otherAgent.id} not found`);
      }
    }
    const lastTogether = await ctx.db
      .query('participatedTogether')
      .withIndex('edge', (q) =>
        q
          .eq('worldId', args.worldId)
          .eq('player1', args.playerId)
          .eq('player2', args.otherPlayerId),
      )
      // Order by conversation end time descending.
      .order('desc')
      .first();

    let lastConversation = null;
    if (lastTogether) {
      lastConversation = await ctx.db
        .query('archivedConversations')
        .withIndex('worldId', (q) =>
          q.eq('worldId', args.worldId).eq('id', lastTogether.conversationId),
        )
        .first();
      if (!lastConversation) {
        throw new Error(`Conversation ${lastTogether.conversationId} not found`);
      }
    }
    // Age, resolved HERE rather than in each prompt builder. Every builder consumes
    // `agent.identity` through agentPrompts(), so keeping the age current at this one point makes
    // it current in the conversation opener, the continuation, the goodbye and the journal alike —
    // and there is no way for one of them to be left behind holding a stale number.
    const { day } = await worldTimeNow(ctx, args.worldId);
    const life = await ageContext(ctx, args.worldId, args.playerId, day);
    const otherLife = await ageContext(ctx, args.worldId, args.otherPlayerId, day);

    return {
      player: { name: playerDescription.name, ...player },
      otherPlayer: { name: otherPlayerDescription.name, ...otherPlayer },
      place: placeLabel(player, playerDescription.name),
      conversation,
      agent: {
        identity: life ? identityAtAge(agentDescription.identity, life.age) : agentDescription.identity,
        plan: agentDescription.plan,
        ...agent,
      },
      otherAgent: otherAgent && {
        identity: otherLife
          ? identityAtAge(otherAgentDescription!.identity, otherLife.age)
          : otherAgentDescription!.identity,
        plan: otherAgentDescription!.plan,
        ...otherAgent,
      },
      life,
      otherLife,
      lastConversation,
    };
  },
});

// The age facts a prompt needs about one character. Null when they have no lifecycle row — an
// un-seeded world then behaves exactly as it did before this existed, rather than asserting
// everyone is zero.
type AgeContext = { age: number; stage: LifeStage; lifespanDays: number };

async function ageContext(
  ctx: any,
  worldId: any,
  pid: string,
  day: number,
): Promise<AgeContext | null> {
  const row = await getLifecycle(ctx, worldId, pid);
  if (!row) return null;
  const age = ageOn(row.diedDay ?? day, row.bornDay);
  return { age, stage: stageFor(age, row.lifespanDays), lifespanDays: row.lifespanDays };
}

// How old they are and what that feels like. The age itself is normally carried INSIDE the
// rewritten identity line (see data/lifecycle.ts), so this adds a bare age only for a character
// whose bio never stated one — someone born at runtime.
function agePrompt(
  life: AgeContext | null,
  identity: string | undefined,
  otherName: string,
  otherLife: AgeContext | null,
): string[] {
  const out: string[] = [];
  if (life) {
    if (identity && !identityStatesAge(identity)) out.push(`You are ${life.age} years old.`);
    const line = stagePromptLine(life.stage, life.age, life.lifespanDays);
    if (line) out.push(line);
  }
  if (otherLife) {
    const seen = othersSeeStage(otherName, otherLife.stage, otherLife.age);
    if (seen) out.push(seen);
  }
  return out;
}

function stopWords(otherPlayer: string, player: string) {
  // These are the words we ask the LLM to stop on. OpenAI only supports 4.
  const variants = [`${otherPlayer} to ${player}`];
  return variants.flatMap((stop) => [stop + ':', stop.toLowerCase() + ':']);
}
