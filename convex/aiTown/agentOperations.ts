import { v } from 'convex/values';
import { internalAction, internalQuery } from '../_generated/server';
import { WorldMap, serializedWorldMap } from './worldMap';
import { chooseDestination } from '../../data/places';
import { composeFeedPost, composeDirectMessage } from './agentComms';
import { rememberConversation } from '../agent/memory';
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
      // First, on an idle tick, maybe publish to the feed or DM someone (rate-limited).
      // Placed before the wander/activity gates so it's actually reached regularly.
      if (await maybeDoComms(ctx, args, now)) {
        return;
      }
      if (recentActivity || justLeftConversation) {
        // Head toward a meaningful place (their home/work or a shared spot) rather than a
        // random tile. Falls back to wandering if we can't resolve who this is.
        const character = await ctx.runQuery(internal.aiTown.agentOperations.getCharacterName, {
          worldId: args.worldId,
          playerId: player.id,
        });
        const destination = character
          ? chooseDestination(character, map.width, map.height)
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
        // TODO: have LLM choose the activity & emoji
        const activity = ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)];
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

async function finishWithActivity(
  ctx: any,
  args: any,
  description: string,
  emoji: string,
  now: number,
) {
  await ctx.runMutation(api.aiTown.main.sendInput, {
    worldId: args.worldId,
    name: 'finishDoSomething',
    args: {
      operationId: args.operationId,
      agentId: args.agent.id,
      activity: { description, emoji, until: now + 12_000 },
    },
  });
}

async function maybeDoComms(ctx: any, args: any, now: number): Promise<boolean> {
  const roll = Math.random();
  const wantPost = roll < FEED_POST_CHANCE;
  const wantDm = !wantPost && roll < FEED_POST_CHANCE + DM_CHANCE;
  if (!wantPost && !wantDm) return false;

  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;

  if (wantPost && now - cc.lastFeedPostAt > FEED_POST_COOLDOWN) {
    const research = RESEARCHERS.has(cc.name) && Math.random() < 0.5;
    const text = await composeFeedPost({
      name: cc.name,
      identity: cc.identity,
      plan: cc.plan,
      memories: cc.memories,
      research,
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
