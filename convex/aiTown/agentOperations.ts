import { v } from 'convex/values';
import { internalAction, internalQuery } from '../_generated/server';
import { WorldMap, serializedWorldMap } from './worldMap';
import { chooseDestination, workFor, nearestPlace } from '../../data/places';
import { Phase, timeOfDayPrompt, WorldTime } from '../../data/clock';
import {
  wageFor,
  mealCost,
  MAX_FOOD,
  FOOD_DRAIN,
  HUNGRY_THRESHOLD,
  MEAL_FOOD,
  STARTING_MONEY,
} from '../../data/economy';
import { composeFeedPost, composeDirectMessage, composeThought } from './agentComms';
import { fetchEmbedding } from '../util/llm';
import { rememberConversation, reflectOnMemories } from '../agent/memory';
import { MAX_ENERGY } from '../agentVitals';
import { GameId, agentId, conversationId, playerId } from './ids';
import {
  continueConversationMessage,
  leaveConversationMessage,
  startConversationMessage,
} from '../agent/conversation';
import { assertNever } from '../util/assertNever';
import { serializedAgent } from './agent';
import { ACTIVITIES, ACTIVITY_COOLDOWN, CONVERSATION_COOLDOWN } from '../constants';
import { api, internal } from '../_generated/api';
import { sleep } from '../util/sleep';
import { serializedPlayer } from './player';

export const agentRememberConversation = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    conversationId,
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    await rememberConversation(
      ctx,
      args.worldId,
      args.agentId as GameId<'agents'>,
      args.playerId as GameId<'players'>,
      args.conversationId as GameId<'conversations'>,
    );
    await sleep(Math.random() * 1000);
    await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: args.worldId,
      name: 'finishRememberConversation',
      args: {
        agentId: args.agentId,
        operationId: args.operationId,
      },
    });
  },
});

export const agentGenerateMessage = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    conversationId,
    otherPlayerId: playerId,
    operationId: v.string(),
    type: v.union(v.literal('start'), v.literal('continue'), v.literal('leave')),
    messageUuid: v.string(),
  },
  handler: async (ctx, args) => {
    let completionFn;
    switch (args.type) {
      case 'start':
        completionFn = startConversationMessage;
        break;
      case 'continue':
        completionFn = continueConversationMessage;
        break;
      case 'leave':
        completionFn = leaveConversationMessage;
        break;
      default:
        assertNever(args.type);
    }
    const text = await completionFn(
      ctx,
      args.worldId,
      args.conversationId as GameId<'conversations'>,
      args.playerId as GameId<'players'>,
      args.otherPlayerId as GameId<'players'>,
    );

    await ctx.runMutation(internal.aiTown.agent.agentSendMessage, {
      worldId: args.worldId,
      conversationId: args.conversationId,
      agentId: args.agentId,
      playerId: args.playerId,
      text,
      messageUuid: args.messageUuid,
      leaveConversation: args.type === 'leave',
      operationId: args.operationId,
    });
  },
});

export const agentDoSomething = internalAction({
  args: {
    worldId: v.id('worlds'),
    player: v.object(serializedPlayer),
    agent: v.object(serializedAgent),
    map: v.object(serializedWorldMap),
    otherFreePlayers: v.array(v.object(serializedPlayer)),
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    const { player, agent } = args;
    const map = new WorldMap(args.map);
    const now = Date.now();
    // Don't try to start a new conversation if we were just in one.
    const justLeftConversation =
      agent.lastConversation && now < agent.lastConversation + CONVERSATION_COOLDOWN;
    // Don't try again if we recently tried to find someone to invite.
    const recentlyAttemptedInvite =
      agent.lastInviteAttempt && now < agent.lastInviteAttempt + CONVERSATION_COOLDOWN;
    const recentActivity = player.activity && now < player.activity.until + ACTIVITY_COOLDOWN;
    // Decide whether to do an activity or wander somewhere.
    if (!player.pathfinding) {
      // What time is it in the world? Drives where agents go and what they post (v1.3).
      const time: WorldTime = await ctx.runQuery(internal.clock.currentTime, {
        worldId: args.worldId,
      });
      // Resolve who this is once (used for vitals/work and for choosing a destination).
      const character = await ctx.runQuery(internal.aiTown.agentOperations.getCharacterName, {
        worldId: args.worldId,
        playerId: player.id,
      });
      // Tick needs + economy: sleep at night (+ overnight consolidation), otherwise drain
      // energy/food, earn wages while working, and eat when hungry. Returns true if this tick
      // was consumed (asleep or eating), in which case we skip the waking behavior below.
      if (await tickVitals(ctx, args, now, time, character)) {
        return;
      }
      // First, on an idle tick, maybe publish to the feed or DM someone (rate-limited).
      // Placed before the wander/activity gates so it's actually reached regularly.
      if (await maybeDoComms(ctx, args, now, time)) {
        return;
      }
      // Otherwise, maybe just have a passing thought (their stream of consciousness, v1.3).
      if (await maybeThink(ctx, args, now, time)) {
        return;
      }
      if (recentActivity || justLeftConversation) {
        // Head toward a meaningful place driven by the time of day: work by day, the bar or
        // park in the evening, home at night. Falls back to wandering if we can't resolve who.
        const destination = character
          ? chooseDestination(character, map.width, map.height, time.phase)
          : wanderDestination(map);
        await sleep(Math.random() * 1000);
        await ctx.runMutation(api.aiTown.main.sendInput, {
          worldId: args.worldId,
          name: 'finishDoSomething',
          args: {
            operationId: args.operationId,
            agentId: agent.id,
            destination,
          },
        });
        return;
      } else {
        // Pick an idle activity, biased by the time of day (work during the day, rest at night).
        const activity = pickActivity(time.phase);
        await sleep(Math.random() * 1000);
        await ctx.runMutation(api.aiTown.main.sendInput, {
          worldId: args.worldId,
          name: 'finishDoSomething',
          args: {
            operationId: args.operationId,
            agentId: agent.id,
            activity: {
              description: activity.description,
              emoji: activity.emoji,
              until: Date.now() + activity.duration,
            },
          },
        });
        return;
      }
    }
    const invitee =
      justLeftConversation || recentlyAttemptedInvite
        ? undefined
        : await ctx.runQuery(internal.aiTown.agent.findConversationCandidate, {
            now,
            worldId: args.worldId,
            player: args.player,
            otherFreePlayers: args.otherFreePlayers,
          });

    // TODO: We hit a lot of OCC errors on sending inputs in this file. It's
    // easy for them to get scheduled at the same time and line up in time.
    await sleep(Math.random() * 1000);
    await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: args.worldId,
      name: 'finishDoSomething',
      args: {
        operationId: args.operationId,
        agentId: args.agent.id,
        invitee,
      },
    });
  },
});

// A focused "doing work" activity for the working day, plus a calmer night set so agents
// aren't "grabbing coffee" at 3am. Falls back to the generic ACTIVITIES mix otherwise.
const WORK_ACTIVITY = { description: 'getting work done', emoji: '💻', duration: 90_000 };
const NIGHT_ACTIVITIES = ACTIVITIES.filter((a) =>
  ['reading a book', 'on a phone call', 'people-watching'].includes(a.description),
);

function pickActivity(phase: Phase) {
  if (phase === 'work' && Math.random() < 0.6) return WORK_ACTIVITY;
  if (phase === 'night') {
    const pool = NIGHT_ACTIVITIES.length ? NIGHT_ACTIVITIES : ACTIVITIES;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  return ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)];
}

function wanderDestination(worldMap: WorldMap) {
  // Wander someonewhere at least one tile away from the edge.
  return {
    x: 1 + Math.floor(Math.random() * (worldMap.width - 2)),
    y: 1 + Math.floor(Math.random() * (worldMap.height - 2)),
  };
}

// v1.2 Steps 3-4 — sometimes an agent publishes to the feed or sends a direct message
// instead of doing an idle activity. Rate-limited per agent; each is one LLM call.
// Comms is checked on every idle tick, so these stay modest; the cooldown is the real
// rate limiter (each post/DM is one local-LLM call).
const FEED_POST_COOLDOWN = 6 * 60_000;
const DM_COOLDOWN = 5 * 60_000;
const FEED_POST_CHANCE = 0.1;
const DM_CHANCE = 0.06;
const RESEARCHERS = new Set(['Mara', 'Priya', 'Naomi']);

// Inner monologue (v1.3): a fleeting private thought now and then while idle. Cheap — one
// LLM call + one embedding, fixed low importance (no importance LLM call). It becomes a
// low-salience memory (so it can feed reflection) and a line in the Town Chronicle.
const THOUGHT_COOLDOWN = 90_000;
const THOUGHT_CHANCE = 0.25;
const THOUGHT_IMPORTANCE = 3;

async function finishWithActivity(
  ctx: any,
  args: any,
  description: string,
  emoji: string,
  now: number,
  durationMs = 12_000,
) {
  await ctx.runMutation(api.aiTown.main.sendInput, {
    worldId: args.worldId,
    name: 'finishDoSomething',
    args: {
      operationId: args.operationId,
      agentId: args.agent.id,
      activity: { description, emoji, until: now + durationMs },
    },
  });
}

// Sleep + energy (v1.3). At night agents sleep: the model goes idle (no dialogue/thoughts/
// wandering), and on the first night tick of a new day they run one overnight consolidation
// (reflectOnMemories) which recharges their energy. By day they're awake and energy drains a
// little with each thing they do. Returns true if the agent is asleep (caller should stop).
const ENERGY_DRAIN = 4; // per waking idle decision
const SLEEP_DURATION = 60_000; // re-decide ~once a minute while asleep (cheap; no LLM)

// True if the agent is standing at their workplace (so working there earns their wage).
function atWorkplace(character: string | null, pos?: { x: number; y: number }): boolean {
  if (!character || !pos) return false;
  const w = workFor(character);
  if (!w) return false;
  return Math.hypot(w.x - pos.x, w.y - pos.y) <= w.radius + 0.5;
}

async function tickVitals(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  character: string | null,
): Promise<boolean> {
  const vitals = await ctx.runQuery(internal.agentVitals.getVitals, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  const asleep = vitals?.asleep ?? false;
  const energy = vitals?.energy ?? MAX_ENERGY;
  const food = vitals?.food ?? MAX_FOOD;
  const money = vitals?.money ?? STARTING_MONEY;
  const lastDay = vitals?.lastConsolidatedDay ?? 0;

  const set = (patch: any) =>
    ctx.runMutation(internal.agentVitals.setVitals, {
      worldId: args.worldId,
      playerId: args.player.id,
      ...patch,
    });

  // --- Night: sleep, with one overnight consolidation that recharges energy. ---
  if (time.phase === 'night') {
    if (!asleep) {
      if (lastDay !== time.day) {
        await reflectOnMemories(ctx, args.worldId, args.player.id);
        await set({ energy: MAX_ENERGY, asleep: true, lastConsolidatedDay: time.day });
      } else {
        await set({ asleep: true });
      }
    }
    await finishWithActivity(ctx, args, 'asleep', '😴', now, SLEEP_DURATION);
    return true;
  }

  // --- Daytime: wake, drain energy + food, earn wages, eat when hungry. ---
  const patch: any = {};
  if (asleep) patch.asleep = false;
  patch.energy = Math.max(0, energy - ENERGY_DRAIN);
  let nextFood = Math.max(0, food - FOOD_DRAIN);
  let nextMoney = money;

  // Earn your wage for working your job during work hours.
  if (time.phase === 'work' && atWorkplace(character, args.player.position)) {
    nextMoney += wageFor(character!);
  }

  // Hungry and can afford a meal? Eat right where you are (price depends on the venue).
  if (nextFood <= HUNGRY_THRESHOLD) {
    const place = args.player.position
      ? nearestPlace(args.player.position.x, args.player.position.y)
      : undefined;
    const cost = mealCost(place?.type);
    if (nextMoney >= cost) {
      nextMoney -= cost;
      nextFood = MEAL_FOOD;
      patch.food = nextFood;
      patch.money = nextMoney;
      await set(patch);
      await finishWithActivity(
        ctx,
        args,
        place ? `eating at ${place.name}` : 'grabbing a bite',
        '🍽️',
        now,
      );
      return true;
    }
  }

  patch.food = nextFood;
  patch.money = nextMoney;
  await set(patch);
  return false;
}

// During the day people are busier on the feed; deep night they mostly go quiet.
function commsActivityMultiplier(phase: Phase): number {
  switch (phase) {
    case 'night':
      return 0.2;
    case 'morning':
      return 0.9;
    case 'work':
      return 1.2;
    case 'evening':
      return 1.1;
  }
}

async function maybeDoComms(ctx: any, args: any, now: number, time: WorldTime): Promise<boolean> {
  const mult = commsActivityMultiplier(time.phase);
  const roll = Math.random();
  const wantPost = roll < FEED_POST_CHANCE * mult;
  const wantDm = !wantPost && roll < (FEED_POST_CHANCE + DM_CHANCE) * mult;
  if (!wantPost && !wantDm) return false;

  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  const timeContext = timeOfDayPrompt(time);

  if (wantPost && now - cc.lastFeedPostAt > FEED_POST_COOLDOWN) {
    // Researchers publish findings during the working day; otherwise it's a personal post.
    const research =
      RESEARCHERS.has(cc.name) &&
      (time.phase === 'work' ? Math.random() < 0.7 : Math.random() < 0.3);
    const text = await composeFeedPost({
      name: cc.name,
      identity: cc.identity,
      plan: cc.plan,
      memories: cc.memories,
      research,
      timeContext,
    });
    if (text) {
      await ctx.runMutation(api.feed.postToFeed, {
        worldId: args.worldId,
        authorPlayerId: args.player.id,
        authorName: cc.name,
        kind: research ? 'research' : 'post',
        text,
      });
      await ctx.runMutation(internal.aiTown.agentComms.recordFeedPost, {
        worldId: args.worldId,
        playerId: args.player.id,
        at: now,
      });
      await finishWithActivity(ctx, args, 'posting to the feed', '📝', now);
      return true;
    }
  }

  if (cc.others.length && now - cc.lastDmAt > DM_COOLDOWN) {
    const to = cc.others[Math.floor(Math.random() * cc.others.length)];
    const text = await composeDirectMessage({
      name: cc.name,
      identity: cc.identity,
      plan: cc.plan,
      toName: to.name,
      memories: cc.memories,
      timeContext,
    });
    if (text) {
      await ctx.runMutation(api.directMessages.sendDirectMessage, {
        worldId: args.worldId,
        fromPlayerId: args.player.id,
        fromName: cc.name,
        toPlayerId: to.playerId,
        text,
      });
      await ctx.runMutation(internal.aiTown.agentComms.recordDm, {
        worldId: args.worldId,
        playerId: args.player.id,
        at: now,
      });
      await finishWithActivity(ctx, args, `messaging ${to.name}`, '✉️', now);
      return true;
    }
  }
  return false;
}

async function maybeThink(ctx: any, args: any, now: number, time: WorldTime): Promise<boolean> {
  if (Math.random() >= THOUGHT_CHANCE) return false;
  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  if (now - cc.lastThoughtAt < THOUGHT_COOLDOWN) return false;

  const text = await composeThought({
    name: cc.name,
    identity: cc.identity,
    plan: cc.plan,
    memories: cc.memories,
    timeContext: timeOfDayPrompt(time),
  });
  if (!text) return false;

  // Store as a low-salience memory so it can still surface / feed reflection.
  const { embedding } = await fetchEmbedding(text);
  const agent = args.agent;
  await ctx.runMutation(internal.agent.memory.insertMemory, {
    agentId: agent.id,
    playerId: args.player.id,
    description: `I thought to myself: ${text}`,
    importance: THOUGHT_IMPORTANCE,
    lastAccess: now,
    data: { type: 'thought' },
    embedding,
  });
  await ctx.runMutation(internal.aiTown.agentComms.recordThought, {
    worldId: args.worldId,
    playerId: args.player.id,
    at: now,
  });
  await ctx.runMutation(internal.townLog.recordEvent, {
    worldId: args.worldId,
    kind: 'thought',
    summary: text,
    playerId: args.player.id,
    playerName: cc.name,
    emoji: '💭',
  });
  await finishWithActivity(ctx, args, 'lost in thought', '💭', now);
  return true;
}

// Resolve a player's display name (e.g. "Mara") so navigation can pick their home/workplace.
export const getCharacterName = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const description = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    return description?.name ?? null;
  },
});
