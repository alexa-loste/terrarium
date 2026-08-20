import { v } from 'convex/values';
import { internalAction, internalQuery } from '../_generated/server';
import { WorldMap, serializedWorldMap } from './worldMap';
import {
  chooseDestination,
  workFor,
  nearestPlace,
  placeByName,
  atPlace,
  homeFor,
  atHome as atHomePlace,
} from '../../data/places';
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
import {
  composeFeedPost,
  composeDirectMessage,
  composeThought,
  composeArtifact,
  composeReaction,
  assessBeliefDrift,
  assessBeliefFormation,
  detectPlan,
  composeGoalReview,
  composeGoalStep,
  composeGatheringPitch,
  composeFactionFounding,
  composeFactionMove,
  composeGossip,
  composeCivicTake,
  composeReciprocityNote,
} from './agentComms';
import { workOutputFor } from '../../data/artifacts';
import {
  isScheduled,
  withinShift,
  jobFor,
  deliverablePay,
  gatheringHourFor,
  sensiblePlanHour,
  workPull,
  workFocus,
} from '../../data/work';
import { moodPromptLine } from '../../data/mood';
import { Places } from '../../data/places';
import {
  CHARGED_TOPICS,
  FOUND_CONVICTION,
  poleLabel as factionPoleLabel,
  priorPole,
} from '../../data/factions';
import {
  CONFIDANT_MIN_AFFINITY,
  GOSSIP_CHANCE,
  GOSSIP_COOLDOWN_MS,
  credibility as gossipCredibility,
  feelingHint,
  opinionScore,
  valenceOf,
} from '../../data/gossip';
import {
  LOBBY_CHANCE,
  LOBBY_COOLDOWN_MS,
  PROPOSE_ISSUE_CHANCE,
  PROPOSE_ISSUE_COOLDOWN_MS,
  propositionFor,
} from '../../data/civics';
import { costOfLivingFor } from '../../data/economy';
import {
  HELP_MIN_AFFINITY,
  RECIPROCATE_CHANCE,
  RECIPROCATE_COOLDOWN_MS,
  generosityFor,
  hasSurplus,
  helpAmount,
  inNeed,
  repayAmount,
  shouldGift,
} from '../../data/reciprocity';
import {
  MAX_PLAN_LOOKAHEAD_DAYS,
  MIN_MESSAGES_FOR_PLAN,
  PLAN_DETECT_COOLDOWN_MS,
  clampPlanOffset,
  planWhenLabel,
} from '../../data/plans';
import {
  driveSeedFor,
  leisureDrainFor,
  workOverLeisureFor,
  gatheringPullFor,
  topDrives,
  driveLabel,
} from '../../data/drives';
import { fetchEmbedding } from '../util/llm';
import { rememberConversation, reflectOnMemories } from '../agent/memory';
import { writeJournalEntry } from '../agent/journal';
import { MAX_ENERGY, START_SOCIAL, START_LEISURE } from '../agentVitals';
import { GameId, agentId, conversationId, playerId } from './ids';
import {
  continueConversationMessage,
  leaveConversationMessage,
  startConversationMessage,
} from '../agent/conversation';
import { assertNever } from '../util/assertNever';
import { AgentTraits } from '../../data/traits';
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
    // v2.0: did this conversation produce a real shared plan? Extract it once into a single
    // structured row both participants read from. Best-effort — never block remembering on it.
    try {
      await maybeFormPlan(ctx, args);
    } catch (e) {
      console.error('maybeFormPlan failed', e);
    }
    // v2.6 — if a town vote is live and they just talked, whoever holds a side sways the other (the
    // tally actually moves through real conversation, not just abstract lobbying). Directional —
    // each speaker runs this on their own end, so A→B and B→A both get their shot.
    try {
      await maybeSwayOnConversation(ctx, args);
    } catch (e) {
      console.error('maybeSwayOnConversation failed', e);
    }
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
      // Resolve who this is + their vitals once (shared by the steps below).
      const character = await ctx.runQuery(internal.aiTown.agentOperations.getCharacterName, {
        worldId: args.worldId,
        playerId: player.id,
      });
      // Their stored traits — home, workplace, job, poles. Null for an un-seeded world, which every
      // data/ accessor reads as "use the name table", i.e. exactly the pre-agentTraits behavior.
      const traits: AgentTraits | null = await ctx.runQuery(internal.agentTraits.traitsFor, {
        worldId: args.worldId,
        playerId: player.id,
      });
      const vitals = await ctx.runQuery(internal.agentVitals.getVitals, {
        worldId: args.worldId,
        playerId: player.id,
      });
      // Tick needs + economy: sleep at night (+ overnight consolidation), otherwise drain
      // energy/food/social, earn wages while working, and eat when hungry. Returns true if this
      // tick was consumed (asleep or eating), in which case we skip the waking behavior below.
      if (await tickVitals(ctx, args, now, time, character, vitals, traits)) {
        return;
      }
      // Pull toward your workplace when the pressure to work is real (v2.9 — personality + finances
      // + catch-up). Covers scheduled shifts AND deliverable workers during the work phase.
      if (await maybeGoToWork(ctx, args, time, character, vitals, traits)) {
        return;
      }
      // v2.8 — if you committed to a gathering happening around now, physically get to the venue;
      // once there, your presence is recorded. You can only be at ONE place at a time, so a
      // double-booked attendee shows up to at most one — exclusivity falls out of the physics.
      if (await maybeAttendGathering(ctx, args, now, time, character)) {
        return;
      }
      // While actually at work during work hours, sometimes produce a real artifact — a
      // research note, policy memo, article, artwork, etc. (their job's tangible output).
      if (await maybeMakeArtifact(ctx, args, now, time, character, traits)) {
        return;
      }
      // v2.9 — actually WORK a goal. A character with a pressing short-term goal spends a beat
      // taking a concrete step toward it (grounded in real effort, fed to the nightly review). This
      // is what makes goals get attained instead of rotting to their deadline.
      if (await maybeWorkOnGoal(ctx, args, now, time, character)) {
        return;
      }
      // First, on an idle tick, maybe publish to the feed or DM someone (rate-limited). A lonely
      // agent (low social) reaches out more. Placed before the wander/activity gates.
      if (await maybeDoComms(ctx, args, now, time, vitals)) {
        return;
      }
      // Otherwise, maybe just have a passing thought (their stream of consciousness, v1.3).
      if (await maybeThink(ctx, args, now, time)) {
        return;
      }
      // Or, now and then, sit down and write in their journal unprompted (v1.7).
      if (await maybeJournal(ctx, args, now, time)) {
        return;
      }
      // Or read a recent piece of someone else's work and react to it through their own
      // convictions — which can shift those convictions + how they feel about the author (v1.8).
      if (await maybeReactToWork(ctx, args, now, time)) {
        return;
      }
      // v2.1 — now and then throw an open gathering (the influence move), or RSVP to someone
      // else's. Drive-gated: recognition/connection-driven characters host + show up more.
      if (await maybeProposeGathering(ctx, args, now, time, character, traits)) {
        return;
      }
      if (await maybeJoinGathering(ctx, args, now, time, character)) {
        return;
      }
      // v2.3 — the GROUP tier. Now and then, found a faction around a strong conviction (turning a
      // belief fault-line into a side), or, if you lead one, take a public stance the town reacts to.
      if (await maybeFormFaction(ctx, args, now, time, character, traits)) {
        return;
      }
      if (await maybeFactionMove(ctx, args, now, time, character)) {
        return;
      }
      // v2.4 — confide a take about someone who isn't here to a friend you trust. Third-party
      // reputation propagates along the edges that already exist (no global force).
      if (await maybeGossip(ctx, args, now, time, character)) {
        return;
      }
      // v2.6 — the CIVIC tier: if you lead a faction, sometimes put a proposition to the town; and
      // if a vote is live, campaign for your side (lobby a contact + post your case).
      if (await maybeProposeIssue(ctx, args, now, time, character)) {
        return;
      }
      if (await maybeCampaign(ctx, args, now, time, character)) {
        return;
      }
      // v2.7 — the HORIZONTAL economy: repay what you owe, or help a friend who's struggling (gift if
      // you're close, lend otherwise). Money finally moves between people, building warmth + debt.
      if (await maybeReciprocate(ctx, args, now, time, character)) {
        return;
      }
      if (recentActivity || justLeftConversation) {
        // Head toward a meaningful place driven by the time of day: work by day, the bar or
        // park in the evening, home at night. Falls back to wandering if we can't resolve who.
        const destination = character
          ? chooseDestination(character, map.width, map.height, time.phase, traits)
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
    // v2.9 — don't go hunting for someone to chat with when you should be working. If you're on
    // shift (or it's the work phase for a deliverable worker), keep your head down most of the
    // time; only occasionally does a workplace conversation strike up. Without this, agents
    // socialize the whole shift away instead of working — the "chatting all day" complaint. The
    // suppression is probabilistic + work-ethic-scaled (workFocus), so the occasional on-shift
    // chat still happens. (Resolved here, in the pathfinding branch, since this is the only path
    // that initiates a conversation; time/character aren't in scope from the idle branch above.)
    let focusingOnWork = false;
    if (!justLeftConversation && !recentlyAttemptedInvite) {
      const time: WorldTime = await ctx.runQuery(internal.clock.currentTime, {
        worldId: args.worldId,
      });
      const character = await ctx.runQuery(internal.aiTown.agentOperations.getCharacterName, {
        worldId: args.worldId,
        playerId: player.id,
      });
      const traits: AgentTraits | null = await ctx.runQuery(internal.agentTraits.traitsFor, {
        worldId: args.worldId,
        playerId: player.id,
      });
      const onShift =
        !!character &&
        (isScheduled(character, traits)
          ? withinShift(character, time.hour, traits)
          : time.phase === 'work');
      focusingOnWork = onShift && Math.random() < workFocus(character!);
    }

    const invitee =
      justLeftConversation || recentlyAttemptedInvite || focusingOnWork
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

// Real work output (v1.6): while at your workplace during work hours, you sometimes produce an
// artifact — your job's tangible output. Gated by work-phase + being at your workplace, plus a
// cooldown + chance, so it's a few pieces per work day. Each is one LLM call + one embedding,
// and the artifact is a salient memory (so it feeds reflection and shows in the Library).
const ARTIFACT_COOLDOWN = 7 * 60_000;
const ARTIFACT_CHANCE = 0.22;
const ARTIFACT_IMPORTANCE = 7;

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
const EVENING_RECOVERY = 5; // v2.10 — energy regained per off-shift evening downtime tick
const LEISURE_RECOVERY = 10; // v2.10 — leisure regained per off-shift evening tick (net + vs drain)
const SOCIAL_DECAY = 1; // social slowly fades with time; conversations/posts replenish it
const SLEEP_DURATION = 60_000; // re-decide ~once a minute while asleep (cheap; no LLM)

// True if the agent is standing at their workplace (so working there earns their wage).
function atWorkplace(
  character: string | null,
  pos?: { x: number; y: number },
  traits?: AgentTraits | null,
): boolean {
  if (!character || !pos) return false;
  const w = workFor(character, traits);
  if (!w) return false;
  return Math.hypot(w.x - pos.x, w.y - pos.y) <= w.radius + 0.5;
}

async function tickVitals(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  character: string | null,
  vitals: any,
  traits: AgentTraits | null,
): Promise<boolean> {
  const asleep = vitals?.asleep ?? false;
  const energy = vitals?.energy ?? MAX_ENERGY;
  const food = vitals?.food ?? MAX_FOOD;
  const money = vitals?.money ?? STARTING_MONEY;
  const social = vitals?.social ?? START_SOCIAL;
  const lastDay = vitals?.lastConsolidatedDay ?? 0;

  const set = (patch: any) =>
    ctx.runMutation(internal.agentVitals.setVitals, {
      worldId: args.worldId,
      playerId: args.player.id,
      ...patch,
    });

  // --- Night: sleep, with one overnight consolidation that recharges energy. ---
  if (time.phase === 'night') {
    const home = character ? homeFor(character, traits) : undefined;
    const isHome = atHomePlace(character, args.player.position, traits);
    if (!asleep) {
      // v2.8 — sleep is PHYSICAL: your own bed gives a full recharge + the overnight consolidation
      // (memory reflection, journaling, belief drift). If you're still out when night falls, head
      // home for it. If you genuinely can't make it back before the night's over you sleep rough —
      // a groggy half-recharge and no consolidation. Soft penalty, not a spiral.
      //
      // v2.8.1 fix (alexa: "they're all sleeping away from home"): two bugs made head-home almost
      // never stick. (1) We fired TWO finishDoSomething inputs with the SAME operationId — one
      // carrying the destination, then finishWithActivity carrying the 🌙 activity. The handler
      // clears inProgressOperation on whichever lands first, so the other is a silent no-op; when
      // the activity won the race it set a STATIONARY status and the walk-home was dropped. Now it's
      // ONE input carrying both destination + activity — no race. (2) The `hour >= 22` gate meant an
      // agent whose first night tick landed after midnight (common when they're mid-conversation as
      // night falls) skipped head-home entirely and bedded down wherever they stood. Night already
      // IS hour>=22||hour<6, so any awake, not-home night tick should be walking home — gate dropped.
      if (!isHome && home) {
        await sleep(Math.random() * 1000);
        await ctx.runMutation(api.aiTown.main.sendInput, {
          worldId: args.worldId,
          name: 'finishDoSomething',
          args: {
            operationId: args.operationId,
            agentId: args.agent.id,
            destination: { x: home.x, y: home.y },
            activity: { description: 'heading home to sleep', emoji: '🌙', until: now + 20_000 },
          },
        });
        return true;
      }
      if (lastDay !== time.day) {
        // Personal consolidation only happens in your own bed.
        if (isHome) {
          await reflectOnMemories(ctx, args.worldId, args.player.id);
          // The day's consolidation gets written up as a journal entry (v1.7).
          await writeJournalEntry(ctx, args.worldId, args.agent.id, args.player.id, 'reflection');
          // ...and the day may have nudged their convictions (v1.8 nightly belief drift).
          await driftBeliefs(ctx, args);
        }
        // v2.1 inner life: settle goals (what got done / what's next + missed deadlines), resolve
        // any gatherings that landed (influence flows to hosts), then recompute mood from it all.
        // World-wide + idempotent — runs regardless of where THIS character bedded down.
        await runNightlyInnerLife(ctx, args, time, character);
        // Retire any pair plans whose day has passed (gatherings are handled above).
        await ctx.runMutation(internal.plans.sweepPast, {
          worldId: args.worldId,
          currentDay: time.day,
        });
        // Reckon the day's work obligation: falling short bites (money + standing) and they
        // stew on it in their journal (v1.9).
        if (character) {
          const verdict = await ctx.runMutation(internal.work.evaluate, {
            worldId: args.worldId,
            playerId: args.player.id,
            playerName: character,
            day: time.day,
          });
          if (verdict.message) {
            await writeJournalEntry(
              ctx,
              args.worldId,
              args.agent.id,
              args.player.id,
              'event',
              verdict.message,
            );
          }
        }
        const recharged = isHome
          ? MAX_ENERGY
          : Math.min(MAX_ENERGY, energy + Math.round(MAX_ENERGY * 0.5));
        await set({ energy: recharged, asleep: true, lastConsolidatedDay: time.day });
      } else {
        await set({ asleep: true });
      }
    }
    await finishWithActivity(
      ctx,
      args,
      isHome ? 'asleep' : 'asleep, away from home',
      '😴',
      now,
      SLEEP_DURATION,
    );
    return true;
  }

  // --- Daytime: wake, drain energy + food, earn wages, eat when hungry. ---
  const patch: any = {};
  if (asleep) patch.asleep = false;
  patch.social = Math.max(0, social - SOCIAL_DECAY);
  // v2.1/v2.10 — leisure + energy need a DAILY refill path or they monotonically crater: leisure
  // had none at all (only gatherings/civics topped it up, so it sat at ~0 townwide), and energy
  // only recharged in the single overnight tick. Fix: off-shift EVENING downtime is RESTORATIVE —
  // both recover instead of draining (the "downtime" the old comment promised but never built).
  // Morning/work hours drain as before; sleep still does the big overnight energy recharge.
  // leisureDrainFor still sets the per-character drain rate by drive (ambitious barely notice).
  const dProfile = (character && driveSeedFor(character)?.profile) || {};
  const onShiftNow =
    !!character && isScheduled(character, traits) && withinShift(character, time.hour, traits);
  if (time.phase === 'evening' && !onShiftNow) {
    patch.energy = Math.min(MAX_ENERGY, energy + EVENING_RECOVERY);
    patch.leisure = Math.min(100, (vitals?.leisure ?? START_LEISURE) + LEISURE_RECOVERY);
  } else {
    patch.energy = Math.max(0, energy - ENERGY_DRAIN);
    patch.leisure = Math.max(0, (vitals?.leisure ?? START_LEISURE) - leisureDrainFor(dProfile));
  }
  let nextFood = Math.max(0, food - FOOD_DRAIN);
  let nextMoney = money;

  // Scheduled workers earn their wage while on shift at their workplace — and being there
  // counts as showing up today (v1.9). Deliverable workers are paid per shipped piece instead.
  if (
    character &&
    isScheduled(character, traits) &&
    withinShift(character, time.hour, traits) &&
    atWorkplace(character, args.player.position, traits)
  ) {
    nextMoney += wageFor(character);
    await ctx.runMutation(internal.work.markAttended, {
      worldId: args.worldId,
      playerId: args.player.id,
      playerName: character,
      day: time.day,
    });
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

// Publishing/messaging is also self-expression and reaching out — it nudges social up.
const POST_SOCIAL_GAIN = 3;
const DM_SOCIAL_GAIN = 2;

async function maybeDoComms(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  vitals: any,
): Promise<boolean> {
  const social = vitals?.social ?? START_SOCIAL;
  // The lonelier you are, the more you reach out.
  const socialNeed = social < 40 ? 1.6 : social < 70 ? 1.1 : 0.9;
  const mult = commsActivityMultiplier(time.phase) * socialNeed;
  const roll = Math.random();
  const wantPost = roll < FEED_POST_CHANCE * mult;
  const wantDm = !wantPost && roll < (FEED_POST_CHANCE + DM_CHANCE) * mult;
  if (!wantPost && !wantDm) return false;

  const bumpSocial = (gain: number) =>
    ctx.runMutation(internal.agentVitals.setVitals, {
      worldId: args.worldId,
      playerId: args.player.id,
      social: Math.min(100, social + gain),
    });

  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  const timeContext = timeOfDayPrompt(time);
  // Posts + DMs should sound like the person — argue from their convictions, not generic-positive.
  const beliefs = await ctx.runQuery(internal.beliefs.forContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });

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
      beliefs,
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
      await bumpSocial(POST_SOCIAL_GAIN);
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
      beliefs,
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
      await bumpSocial(DM_SOCIAL_GAIN);
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

  const beliefs = await ctx.runQuery(internal.beliefs.forContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  // v2.8 — gather the same inner state that colors dialogue, so private thoughts carry the stakes
  // (mood, drives, allegiance + the rival across the line, the live town vote, friction temperament).
  const [vit, drives, faction, civic] = await Promise.all([
    ctx.runQuery(internal.agentVitals.getVitals, { worldId: args.worldId, playerId: args.player.id }),
    ctx.runQuery(internal.drives.topForPlayer, { worldId: args.worldId, playerId: args.player.id }),
    ctx.runQuery(internal.factions.forPlayer, { worldId: args.worldId, playerId: args.player.id }),
    ctx.runQuery(internal.civics.issueForPlayer, { worldId: args.worldId, playerId: args.player.id }),
  ]);
  const inner: string[] = [];
  const mood = vit ? moodPromptLine(vit.stress ?? 25, vit.momentum ?? 50) : null;
  if (mood) inner.push(mood);
  if (drives && drives.length) {
    inner.push(`What drives you, underneath: ${drives.slice(0, 2).map((d: any) => d.label).join('; ')}.`);
  }
  if (faction) {
    let f = `You stand with ${faction.name} (${faction.poleLabel}).`;
    if (faction.rival) f += ` Across the line is ${faction.rival.name}, who you see differently.`;
    inner.push(f);
  }
  if (civic) {
    inner.push(`The town is deciding the ${civic.title}; you're ${civic.myStanceLabel}.`);
  }

  const text = await composeThought({
    name: cc.name,
    identity: cc.identity,
    plan: cc.plan,
    memories: cc.memories,
    beliefs,
    timeContext: timeOfDayPrompt(time),
    inner,
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

// Produce a real artifact while working (v1.6). Only fires during work hours when the agent is
// physically at their workplace; rate-limited by ARTIFACT_COOLDOWN + ARTIFACT_CHANCE. The LLM
// writes role-specific work (data/artifacts.ts), seeded with a few recently-published town
// pieces so it can respond to them — a discourse chain. Persists to the Library, logs to the
// Chronicle, and becomes a salient memory. Returns true if it produced one (tick consumed).
async function maybeMakeArtifact(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  character: string | null,
  traits: AgentTraits | null,
): Promise<boolean> {
  if (time.phase !== 'work' || !character) return false;
  if (!atWorkplace(character, args.player.position, traits)) return false;
  // Behind on your deliverables? You push harder to ship (v1.9).
  const ws = await ctx.runQuery(api.work.getForPlayer, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  const chance = ws?.behind ? ARTIFACT_CHANCE * 1.8 : ARTIFACT_CHANCE;
  if (Math.random() >= chance) return false;

  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  if (now - cc.lastArtifactAt < ARTIFACT_COOLDOWN) return false;

  const output = workOutputFor(character);
  const place = args.player.position
    ? nearestPlace(args.player.position.x, args.player.position.y)
    : undefined;
  const recent = await ctx.runQuery(api.artifacts.recentForContext, {
    worldId: args.worldId,
    limit: 5,
  });
  const beliefs = await ctx.runQuery(internal.beliefs.forContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });

  const piece = await composeArtifact({
    name: cc.name,
    identity: cc.identity,
    plan: cc.plan,
    brief: output.brief,
    workType: output.workType,
    memories: cc.memories,
    recent,
    beliefs,
    placeName: place?.name,
    timeContext: timeOfDayPrompt(time),
  });
  if (!piece) return false;

  await ctx.runMutation(internal.artifacts.createArtifact, {
    worldId: args.worldId,
    authorPlayerId: args.player.id,
    authorName: cc.name,
    workType: output.workType,
    emoji: output.emoji,
    title: piece.title,
    body: piece.body,
    respondsTo: piece.respondsTo,
    placeName: place?.name,
    day: time.day,
  });

  // A salient memory of having made it, so it feeds reflection and future work.
  const memText = `I made a ${output.workType}: "${piece.title}". ${piece.body}`;
  const { embedding } = await fetchEmbedding(memText);
  await ctx.runMutation(internal.agent.memory.insertMemory, {
    agentId: args.agent.id,
    playerId: args.player.id,
    description: memText,
    importance: ARTIFACT_IMPORTANCE,
    lastAccess: now,
    data: { type: 'reflection', relatedMemoryIds: [] },
    embedding,
  });

  await ctx.runMutation(internal.aiTown.agentComms.recordArtifact, {
    worldId: args.worldId,
    playerId: args.player.id,
    at: now,
  });
  const respond = piece.respondsTo ? ` (responding to "${piece.respondsTo}")` : '';
  await ctx.runMutation(internal.townLog.recordEvent, {
    worldId: args.worldId,
    kind: 'artifact',
    summary: `${cc.name} made a ${output.workType}: "${piece.title}"${respond}`,
    playerId: args.player.id,
    playerName: cc.name,
    emoji: output.emoji,
  });
  // Count it toward the quota, and pay deliverable workers for shipping (v1.9).
  await ctx.runMutation(internal.work.recordDeliverable, {
    worldId: args.worldId,
    playerId: args.player.id,
    playerName: character,
    day: time.day,
  });
  if (jobFor(character, traits).kind === 'deliverable') {
    await ctx.runMutation(internal.agentVitals.addMoney, {
      worldId: args.worldId,
      playerId: args.player.id,
      amount: deliverablePay(character),
    });
  }
  // Sometimes they journal about the work they just made (v1.7).
  if (Math.random() < 0.4) {
    await writeJournalEntry(
      ctx,
      args.worldId,
      args.agent.id,
      args.player.id,
      'artifact',
      piece.title,
    );
  }
  await finishWithActivity(ctx, args, output.activity, output.emoji, now, 60_000);
  return true;
}

// Now and then, unprompted, a character sits down and writes in their journal (v1.7). Rare +
// cooldown-gated (the cooldown is shared across all journal triggers, so they won't journal
// right after a nightly/conversation/artifact entry). Daytime only — nights are for sleep +
// the consolidation entry. Returns true if they wrote one.
const JOURNAL_COOLDOWN = 6 * 60_000;
const JOURNAL_CHANCE = 0.05;

async function maybeJournal(ctx: any, args: any, now: number, time: WorldTime): Promise<boolean> {
  if (time.phase === 'night') return false;
  if (Math.random() >= JOURNAL_CHANCE) return false;
  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  if (now - cc.lastJournalAt < JOURNAL_COOLDOWN) return false;
  const ok = await writeJournalEntry(
    ctx,
    args.worldId,
    args.agent.id,
    args.player.id,
    'spontaneous',
  );
  if (!ok) return false;
  await finishWithActivity(ctx, args, 'writing in their journal', '📔', now, 30_000);
  return true;
}

// The overnight belief drift (v1.8): looking back on the day, nudge convictions that moved.
// One cheap LLM call during consolidation; best-effort.
async function driftBeliefs(ctx: any, args: any): Promise<void> {
  try {
    const beliefs = await ctx.runQuery(internal.beliefs.forContext, {
      worldId: args.worldId,
      playerId: args.player.id,
    });
    if (!beliefs.length) return;
    const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
      worldId: args.worldId,
      playerId: args.player.id,
    });
    if (!cc) return;
    const drifts = await assessBeliefDrift({ name: cc.name, beliefs, dayMemories: cc.memories });
    if (drifts.length) {
      await ctx.runMutation(internal.beliefs.applyDrift, {
        worldId: args.worldId,
        playerId: args.player.id,
        drifts,
      });
    }
    // v2.10 — and the day may have crystallized a genuinely NEW conviction (belief formation).
    // Rare by design; grows the idea-space that drift alone leaves fixed.
    const formed = await assessBeliefFormation({
      name: cc.name,
      identity: cc.identity,
      existingTopics: beliefs.map((b: any) => b.topic),
      dayMemories: cc.memories,
    });
    if (formed) {
      await ctx.runMutation(internal.beliefs.addBelief, {
        worldId: args.worldId,
        playerId: args.player.id,
        playerName: cc.name,
        topic: formed.topic,
        statement: formed.statement,
        conviction: formed.conviction,
      });
    }
  } catch (e) {
    console.error('driftBeliefs failed', e);
  }
}

// v2.9 — GOAL PURSUIT. The missing half of the goal system: characters set short-term goals and
// the nightly review judged them, but nothing in the day actually WORKED them, so they rotted to
// their deadlines and got swept as missed (alexa: "they keep making goals they don't even try to
// attain"). Now, on a daytime tick, a character spends a beat advancing their most pressing goal —
// a real concrete step in their own voice — which (a) becomes a visible memory the nightly review
// reads, so completion is GROUNDED in work actually done, and (b) records progress on the goal.
// Urgency-weighted (a deadline bearing down pulls harder) and personality-weighted (a strong work
// ethic raises the floor) — just like irl. Capped to one working session per goal per day.
// v2.10 — raised 0.18 → 0.30. Goals were almost never met: a goal is only marked DONE if it was
// genuinely worked AND its deadline arrives AND a nightly review fires, whereas MISS needs only the
// deadline to pass. Scheduled workers (5 of 8) are on-shift all 'work' phase and only get idle ticks
// to pursue personal goals in the evening, so goals accrued too little effort to be credibly
// finished and just lapsed. A higher base (plus the sleep fix restoring reliable nightly reviews)
// lets goals accumulate enough real work to actually complete. Still urgency/ethic-weighted + 1/day.
const GOAL_WORK_BASE = 0.3;

async function maybeWorkOnGoal(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  character: string | null,
): Promise<boolean> {
  if (time.phase === 'night' || !character) return false;
  const goals = await ctx.runQuery(internal.goals.activeForPlayer, {
    worldId: args.worldId,
    playerId: args.player.id,
    currentDay: time.day,
  });
  if (!goals.long || !goals.shorts.length) return false;
  // Most pressing goal not already worked today (shorts come sorted by due date, soonest first).
  const goal = goals.shorts.find((s: any) => s.lastProgressDay !== time.day);
  if (!goal) return false;
  // A bearing-down deadline pulls hard; a comfortable one barely. Work ethic raises the floor.
  const profile = driveSeedFor(character)?.profile ?? {};
  const ethic = workOverLeisureFor(profile); // ~0..1
  const urgency =
    goal.daysLeft <= 0 ? 1 : goal.daysLeft === 1 ? 0.7 : goal.daysLeft <= 3 ? 0.45 : 0.2;
  const chance = Math.min(0.9, GOAL_WORK_BASE + urgency * 0.5 + ethic * 0.2);
  if (Math.random() >= chance) return false;

  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  const step = await composeGoalStep({
    name: cc.name,
    identity: cc.identity,
    goal: goal.text,
    daysLeft: goal.daysLeft,
    timeContext: timeOfDayPrompt(time),
  });
  if (!step) return false;

  // Record the effort (grounds the nightly credit + caps to one session/day).
  await ctx.runMutation(internal.goals.recordProgress, { goalId: goal.id, day: time.day });

  // A memory of the work done — this is what lets the nightly review honestly credit the goal.
  const memText = `I put real time into a goal today — "${goal.text}": ${step}`;
  const { embedding } = await fetchEmbedding(memText);
  await ctx.runMutation(internal.agent.memory.insertMemory, {
    agentId: args.agent.id,
    playerId: args.player.id,
    description: memText,
    importance: 6,
    lastAccess: now,
    data: { type: 'thought' },
    embedding,
  });
  await ctx.runMutation(internal.townLog.recordEvent, {
    worldId: args.worldId,
    kind: 'thought',
    summary: `Working toward "${goal.text}": ${step}`,
    playerId: args.player.id,
    playerName: cc.name,
    emoji: '🎯',
  });
  await finishWithActivity(ctx, args, 'working toward a goal', '🎯', now, 25_000);
  return true;
}

// Read a recent piece of someone else's work and react to it through your own convictions
// (v1.8). A piece that conflicts with a strong belief lands hard; one you agree with warms you
// to its author. The reaction can shift the reader's conviction and how they feel about the
// author — and becomes a visible memory + Chronicle line. Daytime, rate-limited. This is the
// reactive half of belief change (the nightly drift is the slow half).
const REACT_COOLDOWN = 5 * 60_000;
const REACT_CHANCE = 0.12;
const REACT_IMPORTANCE = 5;

async function maybeReactToWork(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
): Promise<boolean> {
  if (time.phase === 'night') return false;
  if (Math.random() >= REACT_CHANCE) return false;
  const all = await ctx.runQuery(api.artifacts.listArtifacts, { worldId: args.worldId, limit: 12 });
  const others = (all ?? []).filter((a: any) => a.authorPlayerId !== args.player.id);
  if (!others.length) return false;
  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  if (now - cc.lastReactAt < REACT_COOLDOWN) return false;
  const beliefs = await ctx.runQuery(internal.beliefs.forContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!beliefs.length) return false;

  const piece = others[Math.floor(Math.random() * others.length)];
  const r = await composeReaction({
    name: cc.name,
    identity: cc.identity,
    beliefs,
    piece: {
      authorName: piece.authorName,
      workType: piece.workType,
      title: piece.title,
      body: piece.body,
    },
    timeContext: timeOfDayPrompt(time),
  });
  if (!r) return false;

  // Shift the reader's conviction on the belief it touched.
  if (r.convictionDelta && r.topic && r.topic.toLowerCase() !== 'none') {
    await ctx.runMutation(internal.beliefs.nudgeBelief, {
      worldId: args.worldId,
      playerId: args.player.id,
      topic: r.topic,
      delta: r.convictionDelta,
    });
  }
  // Change how they feel about the author.
  if (r.affinityDelta || r.respectDelta) {
    await ctx.runMutation(internal.relationships.nudgeDirected, {
      worldId: args.worldId,
      fromPlayerId: args.player.id,
      fromName: cc.name,
      toPlayerId: piece.authorPlayerId,
      toName: piece.authorName,
      warmth: r.affinityDelta,
      respect: r.respectDelta,
    });
  }
  // A memory of having read + reacted (feeds recall + reflection).
  const memText = `I read ${piece.authorName}'s ${piece.workType} "${piece.title}" and reacted: ${r.reaction}`;
  const { embedding } = await fetchEmbedding(memText);
  await ctx.runMutation(internal.agent.memory.insertMemory, {
    agentId: args.agent.id,
    playerId: args.player.id,
    description: memText,
    importance: REACT_IMPORTANCE,
    lastAccess: now,
    data: { type: 'thought' },
    embedding,
  });
  await ctx.runMutation(internal.aiTown.agentComms.recordReact, {
    worldId: args.worldId,
    playerId: args.player.id,
    at: now,
  });
  await ctx.runMutation(internal.townLog.recordEvent, {
    worldId: args.worldId,
    kind: 'thought',
    summary: `On ${piece.authorName}'s "${piece.title}": ${r.reaction}`,
    playerId: args.player.id,
    playerName: cc.name,
    subjectName: piece.authorName,
    emoji: '👀',
  });
  await finishWithActivity(
    ctx,
    args,
    `reading ${piece.authorName}'s ${piece.workType}`,
    '👀',
    now,
    30_000,
  );
  return true;
}

// Scheduled workers have to be at their workplace during their shift (v1.9). If on shift and
// not there, head over (with a small chance of a detour, so it isn't robotic). Being there is
// what earns the wage + counts as showing up (handled in tickVitals).
async function maybeGoToWork(
  ctx: any,
  args: any,
  time: WorldTime,
  character: string | null,
  vitals: any,
  traits: AgentTraits | null,
): Promise<boolean> {
  if (!character) return false;
  // When should this person be working? A scheduled worker during their shift; a deliverable worker
  // (founder/artist/journalist) through the work phase, when their output is expected. Deliverable
  // workers previously had NO pull to their workplace at all — they only shipped by coincidence.
  const shouldWork = isScheduled(character, traits)
    ? withinShift(character, time.hour, traits)
    : time.phase === 'work';
  if (!shouldWork) return false;
  const w = workFor(character, traits);
  if (!w) return false;
  if (atWorkplace(character, args.player.position, traits)) return false; // already there
  // v2.9 — pressure to actually GO: personality work-ethic + a thin wallet + being behind (catch-up).
  // A low-pressure character skips more, drifts behind, and that catch-up pressure then pulls them
  // back — emergent, like real life — instead of everyone uniformly failing on a flat 20% dice roll.
  const ws = await ctx.runQuery(api.work.getForPlayer, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  const pull = workPull(character, vitals?.money ?? 100, !!ws?.behind);
  if (Math.random() > pull) return false; // not enough pull this tick — do something else
  await sleep(Math.random() * 1000);
  await ctx.runMutation(api.aiTown.main.sendInput, {
    worldId: args.worldId,
    name: 'finishDoSomething',
    args: {
      operationId: args.operationId,
      agentId: args.agent.id,
      destination: { x: w.x, y: w.y },
    },
  });
  return true;
}

// v2.8 — attendance is PHYSICAL. If you RSVP'd to a gathering whose hour is close, head to the
// venue; once you're actually standing there, your presence is recorded (that's what counts at
// resolution, not the RSVP list). You can only be in one place, so if you double-booked you'll
// only make one — the "you have to choose" rule is just geometry. Travel costs time + energy
// emergently: walking across town is more ticks of drain and time you can't spend elsewhere.
const ATTEND_WINDOW_HOURS = 1; // show-up window is [eventHour - 1, eventHour + 1]
async function maybeAttendGathering(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  character: string | null,
): Promise<boolean> {
  if (!character || time.phase === 'night') return false;
  const pos = args.player.position;
  if (!pos) return false;

  const today = await ctx.runQuery(internal.plans.gatheringsTodayFor, {
    worldId: args.worldId,
    playerId: args.player.id,
    currentDay: time.day,
  });
  if (!today.length) return false;

  // In-window events I haven't already been counted at, each resolved to a real venue.
  const live = today
    .filter((g: any) => !g.alreadyPresent && Math.abs(time.hour - g.hour) <= ATTEND_WINDOW_HOURS)
    .map((g: any) => ({ ...g, place: placeByName(g.placeName) }))
    .filter((g: any) => !!g.place);
  if (!live.length) return false;

  // CHOICE under double-booking: an event you host comes first (you can't no-show your own), then
  // the nearest venue (you go where you can actually get to), then the soonest hour.
  const distTo = (g: any) => Math.hypot(g.place.x - pos.x, g.place.y - pos.y);
  live.sort((a: any, b: any) => {
    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
    const d = distTo(a) - distTo(b);
    if (Math.abs(d) > 0.5) return d;
    return a.hour - b.hour;
  });
  const pick = live[0];

  // Already at the venue → mark present and settle in (mingling). Otherwise, walk over.
  if (atPlace(pick.place, pos)) {
    await ctx.runMutation(internal.plans.markPresent, {
      worldId: args.worldId,
      planId: pick.planId,
      playerId: args.player.id,
      playerName: character,
    });
    await finishWithActivity(ctx, args, `at "${pick.title}"`, '🎉', now, 30_000);
    return true;
  }
  const jitter = () => Math.round((Math.random() - 0.5) * 2 * pick.place.radius);
  await sleep(Math.random() * 1000);
  await ctx.runMutation(api.aiTown.main.sendInput, {
    worldId: args.worldId,
    name: 'finishDoSomething',
    args: {
      operationId: args.operationId,
      agentId: args.agent.id,
      destination: { x: pick.place.x + jitter(), y: pick.place.y + jitter() },
    },
  });
  return true;
}

// v2.1 — the overnight inner-life pass: settle the goal ladder, resolve any gatherings that
// landed today (which moves standing + leisure + momentum), then recompute mood from the result.
// Cheap: one LLM call (the goal review) plus structured bookkeeping. Best-effort throughout.
async function runNightlyInnerLife(
  ctx: any,
  args: any,
  time: WorldTime,
  character: string | null,
): Promise<void> {
  if (!character) return;
  try {
    // Review the ladder FIRST — what got reached today (including goals whose deadline has just
    // arrived), and the next 1-2 milestones. Doing this before the overdue sweep lets the review
    // credit a goal you've plausibly finished instead of the sweep marking it missed underneath you.
    const goals = await ctx.runQuery(internal.goals.activeForPlayer, {
      worldId: args.worldId,
      playerId: args.player.id,
      currentDay: time.day,
    });
    const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
      worldId: args.worldId,
      playerId: args.player.id,
    });
    if (goals.long && cc) {
      const review = await composeGoalReview({
        name: cc.name,
        identity: cc.identity,
        aspiration: goals.long.text,
        shorts: goals.shorts.map((s: any) => ({
          text: s.text,
          daysLeft: s.daysLeft,
          workedDays: s.progressDays,
        })),
        dayMemories: cc.memories,
        maxNewDays: 5,
      });
      for (const idx of review.done) {
        const g = goals.shorts[idx - 1];
        if (g)
          await ctx.runMutation(internal.goals.markGoal, {
            goalId: g.id,
            status: 'done',
            note: 'reached it',
            day: time.day,
          });
      }
      for (const ns of review.newShorts) {
        await ctx.runMutation(internal.goals.addShort, {
          worldId: args.worldId,
          playerId: args.player.id,
          playerName: character,
          text: ns.text,
          dueDay: time.day + ns.days,
          currentDay: time.day,
        });
      }
    }

    // Now the deadlines: any active short goal STILL past its due day (the review didn't finish it)
    // becomes a miss — and stings.
    const swept = await ctx.runMutation(internal.goals.sweepOverdue, {
      worldId: args.worldId,
      playerId: args.player.id,
      currentDay: time.day,
    });

    // Resolve gatherings that have arrived (world-wide + idempotent — first sleeper does it).
    await ctx.runMutation(internal.plans.resolveDueGatherings, {
      worldId: args.worldId,
      currentDay: time.day,
    });

    // v2.6 — resolve a civic vote whose campaign has run its course (world-wide + idempotent). The
    // outcome lands on everyone's mood/standing/faction inside resolveDue; journal it for whoever
    // trips the resolution.
    try {
      const civic = await ctx.runMutation(internal.civics.resolveDue, {
        worldId: args.worldId,
        currentDay: time.day,
      });
      if (civic?.resolved) {
        await writeJournalEntry(
          ctx,
          args.worldId,
          args.agent.id,
          args.player.id,
          'event',
          civic.headline,
        );
      }
    } catch (e) {
      console.error('civic resolveDue failed', e);
    }

    // v2.3 — let affiliations breathe: ease every faction tie toward where this character's CURRENT
    // convictions + friendships put them (drift quietly strengthens or erodes ties), and seed any new
    // pull they've developed toward a faction they're not in yet. Crossings get a journal beat.
    let factionShift: { joined: string[]; left: string[] } = { joined: [], left: [] };
    try {
      factionShift = await ctx.runMutation(internal.factions.nightlyAffiliation, {
        worldId: args.worldId,
        playerId: args.player.id,
        playerName: character,
        currentDay: time.day,
      });
    } catch (e) {
      console.error('nightlyAffiliation failed', e);
    }

    // v2.7 — a loan you made that's gone unpaid for days quietly sours you on the borrower.
    try {
      await ctx.runMutation(internal.reciprocity.agedDebtResentment, {
        worldId: args.worldId,
        creditorPlayerId: args.player.id,
        creditorName: character,
        currentDay: time.day,
      });
    } catch (e) {
      console.error('agedDebtResentment failed', e);
    }

    // Recompute mood from the now-settled state (needs, goals, standing).
    await ctx.runMutation(internal.mood.recompute, {
      worldId: args.worldId,
      playerId: args.player.id,
      currentDay: time.day,
    });

    if (factionShift.joined.length || factionShift.left.length) {
      const note = [...factionShift.joined, ...factionShift.left][0];
      await writeJournalEntry(ctx, args.worldId, args.agent.id, args.player.id, 'event', note);
    }

    // A blown deadline is worth stewing on.
    if (swept.missed.length) {
      await writeJournalEntry(
        ctx,
        args.worldId,
        args.agent.id,
        args.player.id,
        'event',
        `a deadline you set yourself slipped — ${swept.missed[0]}`,
      );
    }
  } catch (e) {
    console.error('runNightlyInnerLife failed', e);
  }
}

const GATHER_COOLDOWN = 1000 * 60 * 8; // don't propose/join gatherings too often
const PROPOSE_GATHER_CHANCE = 0.08;
const JOIN_GATHER_CHANCE = 0.5;

// v2.1 — a character throws an OPEN gathering: the influence move. Gated by how much being-seen /
// being-together drives them (recognition + connection), a cooldown, and a cap of one open event
// at a time. Picks a fitting venue + a near day, writes a real in-character pitch, and invites the
// town. Hosting events people come to is how they grow standing (see plans.resolveDueGatherings).
async function maybeProposeGathering(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  character: string | null,
  traits: AgentTraits | null,
): Promise<boolean> {
  if (!character || time.phase === 'night') return false;
  const seed = driveSeedFor(character);
  if (!seed) return false;
  const pull = gatheringPullFor(seed.profile);
  if (Math.random() >= PROPOSE_GATHER_CHANCE * (0.4 + pull)) return false;

  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  if (now - cc.lastGatherAt < GATHER_COOLDOWN) return false;
  const alreadyHosting = await ctx.runQuery(internal.plans.upcomingHostedBy, {
    worldId: args.worldId,
    playerId: args.player.id,
    currentDay: time.day,
  });
  if (alreadyHosting >= 1) return false;

  // A venue that suits a gathering — prefer social/cultural/civic spots over offices.
  const venues = Places.filter((p) =>
    ['cafe', 'public', 'culture', 'civic', 'nightlife'].includes(p.type),
  );
  if (!venues.length) return false;
  const place = venues[Math.floor(Math.random() * venues.length)];
  const beliefs = await ctx.runQuery(internal.beliefs.forContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  const top = topDrives(seed.profile, 1)[0];
  const pitch = await composeGatheringPitch({
    name: cc.name,
    identity: cc.identity,
    beliefs,
    placeName: place.name,
    driveHint: top ? driveLabel(top.key) : undefined,
  });
  if (!pitch) return false;

  const day = time.day + 1 + Math.floor(Math.random() * 3); // 1-3 days out
  // An evening slot after the host's own workday, never in the dead of night (v2.3).
  const hour = gatheringHourFor(character, Math.random(), traits);
  await ctx.runMutation(internal.plans.proposeGathering, {
    worldId: args.worldId,
    title: pitch.title,
    description: pitch.blurb || undefined,
    day,
    hour,
    placeName: place.name,
    hostPlayerId: args.player.id,
    hostName: cc.name,
    createdDay: time.day,
  });
  await ctx.runMutation(internal.aiTown.agentComms.recordGather, {
    worldId: args.worldId,
    playerId: args.player.id,
    at: now,
  });
  const whenStr = planWhenLabel(day, time.day, hour);
  const memText = `I'm hosting "${pitch.title}" at ${place.name} (${whenStr}) — I want people to come.`;
  const { embedding } = await fetchEmbedding(memText);
  await ctx.runMutation(internal.agent.memory.insertMemory, {
    agentId: args.agent.id,
    playerId: args.player.id,
    description: memText,
    importance: 7,
    lastAccess: now,
    data: { type: 'thought' },
    embedding,
  });
  await ctx.runMutation(internal.townLog.recordEvent, {
    worldId: args.worldId,
    kind: 'feed',
    summary: `${cc.name} is hosting "${pitch.title}" at ${place.name} (${whenStr}) — open to all.`,
    playerId: args.player.id,
    playerName: cc.name,
    emoji: '📣',
  });
  await finishWithActivity(ctx, args, `planning "${pitch.title}"`, '📣', now, 30_000);
  return true;
}

// v2.1 — decide whether to join an open gathering someone else is throwing. Weighted by how warm
// they already are to the host, how much being-among-people drives them, and a cooldown. Joining
// is what gives the host turnout (and thus influence) — and gives the joiner something to look
// forward to.
async function maybeJoinGathering(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  character: string | null,
): Promise<boolean> {
  if (!character || time.phase === 'night') return false;
  if (Math.random() >= JOIN_GATHER_CHANCE) return false;
  const open = await ctx.runQuery(internal.plans.openGatheringsToJoin, {
    worldId: args.worldId,
    playerId: args.player.id,
    currentDay: time.day,
  });
  if (!open.length) return false;
  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  if (now - cc.lastGatherAt < GATHER_COOLDOWN) return false;

  const seed = driveSeedFor(character);
  const pull = seed ? gatheringPullFor(seed.profile) : 0.4;
  // Low-pull characters need a real reason; high-pull ones say yes more readily.
  if (Math.random() > 0.3 + pull * 0.6) return false;

  const pick = open[Math.floor(Math.random() * open.length)];
  await ctx.runMutation(internal.plans.joinPlan, {
    planId: pick.id,
    playerId: args.player.id,
    playerName: cc.name,
  });
  await ctx.runMutation(internal.aiTown.agentComms.recordGather, {
    worldId: args.worldId,
    playerId: args.player.id,
    at: now,
  });
  const when = planWhenLabel(pick.day, time.day);
  const memText = `I'm going to ${pick.hostName}'s "${pick.title}" at ${pick.placeName ?? 'their place'}, ${when}.`;
  const { embedding } = await fetchEmbedding(memText);
  await ctx.runMutation(internal.agent.memory.insertMemory, {
    agentId: args.agent.id,
    playerId: args.player.id,
    description: memText,
    importance: 6,
    lastAccess: now,
    data: { type: 'thought' },
    embedding,
  });
  await finishWithActivity(ctx, args, `RSVPing to ${pick.hostName}'s gathering`, '🙋', now, 20_000);
  return true;
}

// v2.3 — FACTIONS. Founding is rare (a real act); public stances are a bit more frequent (that's
// what keeps commitment moving). Both are LLM-gated and on long cooldowns so the town doesn't turn
// into a debate club.
const FACTION_COOLDOWN = 1000 * 60 * 15; // at most ~once per 15 min real-time, per agent
const FORM_FACTION_CHANCE = 0.12;
const FACTION_MOVE_COOLDOWN = 1000 * 60 * 12;
const FACTION_MOVE_CHANCE = 0.16;

// Found a faction around a strong, charged conviction — if there's at least one like-minded ally to
// crystallize a real side (and no faction already on this bank of the fault line). Auto-pulls the
// founder's named allies in as members.
async function maybeFormFaction(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  character: string | null,
  traits: AgentTraits | null,
): Promise<boolean> {
  if (!character || time.phase === 'night') return false;
  if (Math.random() >= FORM_FACTION_CHANCE) return false;

  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  if (now - cc.lastFactionAt < FACTION_COOLDOWN) return false;

  const snap = await ctx.runQuery(internal.factions.membershipSnapshot, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (snap.anyMember) return false; // already anchored in a faction — don't start another

  const beliefs = await ctx.runQuery(internal.beliefs.forContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  // A foundable conviction: charged topic, strong, I have a clear side, and no faction yet on my bank.
  const foundable = (beliefs as { topic: string; statement: string; conviction: number }[])
    .filter(
      (b) =>
        (CHARGED_TOPICS as readonly string[]).includes(b.topic) &&
        b.conviction >= FOUND_CONVICTION &&
        priorPole(character, b.topic, traits) != null,
    )
    .filter((b) => {
      const myPole = priorPole(character, b.topic, traits)!;
      return !snap.banks.includes(`${b.topic}:${Math.sign(myPole)}`);
    })
    .sort((a, b) => b.conviction - a.conviction);
  if (!foundable.length) return false;
  const pick = foundable[0];
  const myPole = priorPole(character, pick.topic, traits)!;

  // Who else in town has a side on this topic (for the founder to weigh as ally or opponent)?
  // Everyone else's poles in one query — a runtime-born townsperson has a side too, and it lives
  // in their traits row, not in the name table.
  const traitsByPlayer: Record<string, AgentTraits> = await ctx.runQuery(
    internal.agentTraits.traitsForWorld,
    { worldId: args.worldId },
  );
  const candidates = (cc.others as { playerId: string; name: string }[])
    .map((o) => ({
      playerId: o.playerId,
      name: o.name,
      pole: priorPole(o.name, pick.topic, traitsByPlayer[String(o.playerId)]),
    }))
    .filter((o): o is { playerId: string; name: string; pole: 1 | -1 } => o.pole != null);
  const allies = candidates.filter((o) => Math.sign(o.pole) === Math.sign(myPole));
  if (!allies.length) return false; // a faction of one isn't a side

  const founding = await composeFactionFounding({
    name: cc.name,
    identity: cc.identity,
    beliefs,
    topic: pick.topic,
    poleLabel: factionPoleLabel(pick.topic, myPole),
    statement: pick.statement,
    candidates: candidates.map((c) => ({
      name: c.name,
      leaning: factionPoleLabel(pick.topic, c.pole),
    })),
  });
  if (!founding) return false;

  // Restrict recruits to people genuinely on the founder's bank; fall back to the strongest ally so
  // the group never lands as a singleton.
  const allyByName = new Map(allies.map((a) => [a.name, a]));
  let recruits = founding.recruits
    .map((n) => allyByName.get(n))
    .filter((a): a is { playerId: string; name: string; pole: 1 | -1 } => !!a)
    .map((a) => ({ playerId: a.playerId, playerName: a.name }));
  if (!recruits.length) recruits = [{ playerId: allies[0].playerId, playerName: allies[0].name }];

  const res = await ctx.runMutation(internal.factions.createFaction, {
    worldId: args.worldId,
    name: founding.name,
    topic: pick.topic,
    pole: myPole,
    premise: founding.premise,
    founderPlayerId: args.player.id,
    founderName: cc.name,
    foundedDay: time.day,
    recruits,
  });
  await ctx.runMutation(internal.aiTown.agentComms.recordFaction, {
    worldId: args.worldId,
    playerId: args.player.id,
    at: now,
  });
  if (!res?.created) return true; // folded into an existing faction — still counts as the action

  const memText = `I started ${founding.name} — people who see ${pick.topic} the way I do (${factionPoleLabel(
    pick.topic,
    myPole,
  )}). ${founding.premise}`;
  const { embedding } = await fetchEmbedding(memText);
  await ctx.runMutation(internal.agent.memory.insertMemory, {
    agentId: args.agent.id,
    playerId: args.player.id,
    description: memText,
    importance: 8,
    lastAccess: now,
    data: { type: 'thought' },
    embedding,
  });
  await writeJournalEntry(
    ctx,
    args.worldId,
    args.agent.id,
    args.player.id,
    'event',
    `you started ${founding.name} around ${pick.topic} — you're done waiting for others to act`,
  );
  await finishWithActivity(ctx, args, `rallying ${founding.name}`, '🤝', now, 30_000);
  return true;
}

// If this character leads a faction, now and then take a public stance for it — a feed post in the
// faction's name that members react to (the engine that moves commitment). At most ~once a day per
// faction.
async function maybeFactionMove(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  character: string | null,
): Promise<boolean> {
  if (!character || time.phase === 'night') return false;
  if (Math.random() >= FACTION_MOVE_CHANCE) return false;

  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  if (now - cc.lastFactionMoveAt < FACTION_MOVE_COOLDOWN) return false;

  const lead = await ctx.runQuery(internal.factions.leadFactionFor, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!lead) return false;
  if (lead.lastMoveDay != null && lead.lastMoveDay >= time.day) return false; // one stance/day

  const stance = await composeFactionMove({
    factionName: lead.name,
    premise: lead.premise,
    poleLabel: lead.poleLabel,
    topic: lead.topic,
    leadName: cc.name,
    identity: cc.identity,
    rivalName: lead.rivalName,
    hot: lead.intensity >= 66,
  });
  if (!stance) return false;

  const moveIntensity = Math.min(100, lead.intensity + 8);
  await ctx.runMutation(internal.factions.recordMove, {
    worldId: args.worldId,
    factionId: lead.factionId,
    stance,
    moveIntensity,
    currentDay: time.day,
  });
  // Publish to the feed in the faction's voice (mirrors into the chronicle automatically).
  await ctx.runMutation(api.feed.postToFeed, {
    worldId: args.worldId,
    authorPlayerId: args.player.id,
    authorName: `${cc.name} · ${lead.name}`,
    kind: 'post',
    text: stance,
  });
  await ctx.runMutation(internal.aiTown.agentComms.recordFactionMove, {
    worldId: args.worldId,
    playerId: args.player.id,
    at: now,
  });
  await finishWithActivity(ctx, args, `speaking for ${lead.name}`, '🚩', now, 24_000);
  return true;
}

// v2.4 — GOSSIP. Confide a genuine take about an absent third party to a friend. Emergent: the
// speaker only passes along an opinion they actually hold, to someone they're actually warm with, and
// it moves the listener in proportion to how much they trust the speaker. Reputation flows along
// existing edges — nobody is forced to feel anything.
const GOSSIP_SUBJECT_POOL = 3; // pick among the few people you feel most strongly about
async function maybeGossip(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  character: string | null,
): Promise<boolean> {
  if (!character || time.phase === 'night') return false;
  if (Math.random() >= GOSSIP_CHANCE) return false;

  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  if (now - cc.lastGossipAt < GOSSIP_COOLDOWN_MS) return false;

  const nameOf = new Map<string, string>(
    (cc.others as { playerId: string; name: string }[]).map((o) => [o.playerId, o.name]),
  );

  // How the speaker feels about everyone.
  const rels = (await ctx.runQuery(api.relationships.getRelationships, {
    worldId: args.worldId,
    playerId: args.player.id,
  })) as {
    toPlayerId: string;
    affinity: number;
    respect: number;
    trust: number;
    familiarity: number;
  }[];
  if (!rels.length) return false;

  // Subject: someone they hold a real opinion about (warm or cool), among the strongest few.
  const opinions = rels
    .filter((r) => nameOf.has(r.toPlayerId) && valenceOf(r) !== 0)
    .sort((a, b) => Math.abs(opinionScore(b)) - Math.abs(opinionScore(a)));
  if (!opinions.length) return false;
  const subjectRel = opinions[Math.floor(Math.random() * Math.min(GOSSIP_SUBJECT_POOL, opinions.length))];
  const subjectName = nameOf.get(subjectRel.toPlayerId)!;

  // Confidant: a friend they're warm with, who ISN'T the subject.
  const confidants = rels.filter(
    (r) =>
      nameOf.has(r.toPlayerId) &&
      r.toPlayerId !== subjectRel.toPlayerId &&
      r.affinity >= CONFIDANT_MIN_AFFINITY,
  );
  if (!confidants.length) return false;
  const confidant = confidants[Math.floor(Math.random() * confidants.length)];
  const confidantName = nameOf.get(confidant.toPlayerId)!;

  // How much the confidant trusts the speaker → how much this moves them.
  const confRels = (await ctx.runQuery(api.relationships.getRelationships, {
    worldId: args.worldId,
    playerId: confidant.toPlayerId,
  })) as { toPlayerId: string; trust: number }[];
  const trustInSpeaker = confRels.find((r) => r.toPlayerId === args.player.id)?.trust ?? 50;
  const cred = gossipCredibility(trustInSpeaker);

  const valence = valenceOf(subjectRel);
  const beliefs = await ctx.runQuery(internal.beliefs.forContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  const line = await composeGossip({
    speakerName: cc.name,
    identity: cc.identity,
    beliefs,
    subjectName,
    listenerName: confidantName,
    feelingHint: feelingHint(subjectRel),
  });
  if (!line) return false;

  await ctx.runMutation(internal.gossip.recordGossip, {
    worldId: args.worldId,
    speakerPlayerId: args.player.id,
    speakerName: cc.name,
    listenerPlayerId: confidant.toPlayerId,
    listenerName: confidantName,
    subjectPlayerId: subjectRel.toPlayerId,
    subjectName,
    valence,
    credibility: cred,
    line,
    day: time.day,
  });
  await ctx.runMutation(internal.aiTown.agentComms.recordGossipState, {
    worldId: args.worldId,
    playerId: args.player.id,
    at: now,
  });

  const memText = `I told ${confidantName} how I really see ${subjectName}: ${line}`;
  const { embedding } = await fetchEmbedding(memText);
  await ctx.runMutation(internal.agent.memory.insertMemory, {
    agentId: args.agent.id,
    playerId: args.player.id,
    description: memText,
    importance: 5,
    lastAccess: now,
    data: { type: 'thought' },
    embedding,
  });
  await finishWithActivity(ctx, args, `talking about ${subjectName} with ${confidantName}`, '🗣️', now, 18_000);
  return true;
}

// v2.6 — CIVIC. If you lead a faction and no vote is live, put your faction's proposition to the
// town (only when the proposition is on YOUR side of the fault line — you're championing it).
async function maybeProposeIssue(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  character: string | null,
): Promise<boolean> {
  if (!character || time.phase === 'night') return false;
  if (Math.random() >= PROPOSE_ISSUE_CHANCE) return false;

  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  if (now - cc.lastIssueAt < PROPOSE_ISSUE_COOLDOWN_MS) return false;
  if (!(await ctx.runQuery(internal.civics.noActiveIssue, { worldId: args.worldId }))) return false;

  const lead = await ctx.runQuery(internal.factions.leadFactionFor, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!lead) return false;
  const prop = propositionFor(lead.topic);
  // Only champion a proposition that advances your own side of the fault line.
  if (!prop || Math.sign(prop.favorsPole) !== Math.sign(lead.pole)) return false;

  const res = await ctx.runMutation(internal.civics.openIssue, {
    worldId: args.worldId,
    topic: lead.topic,
    proposerPlayerId: args.player.id,
    proposerName: cc.name,
    proposerFactionId: lead.factionId,
    openedDay: time.day,
  });
  if (!res?.opened) return false;
  await ctx.runMutation(internal.aiTown.agentComms.recordIssue, {
    worldId: args.worldId,
    playerId: args.player.id,
    at: now,
  });

  const beliefs = await ctx.runQuery(internal.beliefs.forContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  const take = await composeCivicTake({
    name: cc.name,
    identity: cc.identity,
    beliefs,
    issueTitle: prop.title,
    issueText: prop.text,
    myStanceLabel: `for the ${prop.title}`,
  });
  if (take) {
    await ctx.runMutation(api.feed.postToFeed, {
      worldId: args.worldId,
      authorPlayerId: args.player.id,
      authorName: cc.name,
      kind: 'post',
      text: take,
    });
  }
  await finishWithActivity(ctx, args, `putting ${prop.title} to the town`, '🏛️', now, 30_000);
  return true;
}

// v2.6 — CIVIC campaign: when a vote is live and you hold a side, lobby a contact (persuasion scaled
// by their trust in you — the gossip credibility model) and post your public case to the feed.
async function maybeCampaign(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  character: string | null,
): Promise<boolean> {
  if (!character || time.phase === 'night') return false;
  if (Math.random() >= LOBBY_CHANCE) return false;

  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  if (now - cc.lastLobbyAt < LOBBY_COOLDOWN_MS) return false;

  const issue = await ctx.runQuery(internal.civics.issueForPlayer, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!issue || issue.myStance === 'undecided') return false; // can't campaign with no side

  // Lobby a contact — someone the speaker knows. Their trust in the speaker sets how much it lands.
  const rels = (await ctx.runQuery(api.relationships.getRelationships, {
    worldId: args.worldId,
    playerId: args.player.id,
  })) as { toPlayerId: string; familiarity: number }[];
  const nameOf = new Map<string, string>(
    (cc.others as { playerId: string; name: string }[]).map((o) => [o.playerId, o.name]),
  );
  const contacts = rels.filter((r) => nameOf.has(r.toPlayerId) && r.familiarity > 8);
  if (contacts.length) {
    const target = contacts[Math.floor(Math.random() * Math.min(4, contacts.length))];
    const targetRels = (await ctx.runQuery(api.relationships.getRelationships, {
      worldId: args.worldId,
      playerId: target.toPlayerId,
    })) as { toPlayerId: string; trust: number }[];
    const trustInMe = targetRels.find((r) => r.toPlayerId === args.player.id)?.trust ?? 50;
    await ctx.runMutation(internal.civics.lobby, {
      worldId: args.worldId,
      issueId: issue.issueId,
      lobbyistPlayerId: args.player.id,
      targetPlayerId: target.toPlayerId,
      credibility: gossipCredibility(trustInMe),
    });
  }

  // And make the public case.
  const beliefs = await ctx.runQuery(internal.beliefs.forContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  const take = await composeCivicTake({
    name: cc.name,
    identity: cc.identity,
    beliefs,
    issueTitle: issue.title,
    issueText: issue.text,
    myStanceLabel: issue.myStanceLabel,
  });
  if (take) {
    await ctx.runMutation(api.feed.postToFeed, {
      worldId: args.worldId,
      authorPlayerId: args.player.id,
      authorName: cc.name,
      kind: 'post',
      text: take,
    });
  }
  await ctx.runMutation(internal.aiTown.agentComms.recordLobby, {
    worldId: args.worldId,
    playerId: args.player.id,
    at: now,
  });
  await finishWithActivity(ctx, args, `campaigning on ${issue.title}`, '📣', now, 22_000);
  return true;
}

// v2.7 — RECIPROCITY. Money + favors moving between people. Priority: first repay a debt that nags
// (if you can afford it), else help a friend who's struggling (gift if you're close, lend otherwise).
// Emergent + non-coercive: you only help people you're genuinely warm with, only when you have real
// slack and they're in real need.
async function maybeReciprocate(
  ctx: any,
  args: any,
  now: number,
  time: WorldTime,
  character: string | null,
): Promise<boolean> {
  if (!character || time.phase === 'night') return false;
  if (Math.random() >= RECIPROCATE_CHANCE) return false;

  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (!cc) return false;
  if (now - cc.lastReciprocateAt < RECIPROCATE_COOLDOWN_MS) return false;

  const myVit = await ctx.runQuery(internal.agentVitals.getVitals, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  const myMoney = myVit?.money ?? 0;
  const myCOL = costOfLivingFor(character);
  const profile = await ctx.runQuery(internal.drives.profileFor, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  const gen = generosityFor(profile ?? {});

  // 1) Repay what you owe, if you can do it without putting yourself in hardship.
  const ledger = await ctx.runQuery(internal.reciprocity.ledgerForPlayer, {
    worldId: args.worldId,
    playerId: args.player.id,
  });
  if (ledger.owe.length) {
    const debt = ledger.owe[0];
    const pay = repayAmount(debt.amount, myMoney, myCOL);
    if (pay > 0) {
      await ctx.runMutation(internal.reciprocity.repay, {
        worldId: args.worldId,
        fromPlayerId: args.player.id,
        fromName: cc.name,
        toPlayerId: debt.playerId,
        toName: debt.name,
        amount: pay,
        day: time.day,
      });
      await ctx.runMutation(internal.aiTown.agentComms.recordReciprocate, {
        worldId: args.worldId,
        playerId: args.player.id,
        at: now,
      });
      await finishWithActivity(ctx, args, `settling up with ${debt.name}`, '↩️', now, 16_000);
      return true;
    }
  }

  // 2) Help a warm friend who's struggling — but only if you've got real slack yourself.
  if (!hasSurplus(myMoney, myCOL)) return false;
  const rels = (await ctx.runQuery(api.relationships.getRelationships, {
    worldId: args.worldId,
    playerId: args.player.id,
  })) as { toPlayerId: string; affinity: number }[];
  const allVitals = (await ctx.runQuery(api.agentVitals.listVitals, {
    worldId: args.worldId,
  })) as { playerId: string; money: number }[];
  const nameOf = new Map<string, string>(
    (cc.others as { playerId: string; name: string }[]).map((o) => [o.playerId, o.name]),
  );
  const moneyOf = new Map<string, number>(allVitals.map((v) => [String(v.playerId), v.money]));

  // Warm contacts who are in need, neediest first.
  const candidates = rels
    .filter((r) => r.affinity >= HELP_MIN_AFFINITY && nameOf.has(r.toPlayerId))
    .map((r) => ({
      playerId: r.toPlayerId,
      name: nameOf.get(r.toPlayerId)!,
      affinity: r.affinity,
      money: moneyOf.get(String(r.toPlayerId)) ?? 999,
      col: costOfLivingFor(nameOf.get(r.toPlayerId)!),
    }))
    .filter((c) => inNeed(c.money, c.col))
    .sort((a, b) => a.money / a.col - b.money / b.col);
  if (!candidates.length) return false;

  const who = candidates[0];
  const amount = helpAmount(myMoney, myCOL, who.col, gen);
  if (amount <= 0) return false;

  const gift = shouldGift(who.affinity, gen);
  let note: string | null = null;
  if (gift) {
    note = await composeReciprocityNote({
      name: cc.name,
      identity: cc.identity,
      recipientName: who.name,
      kind: 'gift',
    });
  }
  await ctx.runMutation(gift ? internal.reciprocity.giveGift : internal.reciprocity.lend, {
    worldId: args.worldId,
    fromPlayerId: args.player.id,
    fromName: cc.name,
    toPlayerId: who.playerId,
    toName: who.name,
    amount,
    note: note ?? undefined,
    day: time.day,
  });
  await ctx.runMutation(internal.aiTown.agentComms.recordReciprocate, {
    worldId: args.worldId,
    playerId: args.player.id,
    at: now,
  });
  const memText = gift
    ? `I helped ${who.name} out with ${amount} — they've been stretched thin.`
    : `I lent ${who.name} ${amount} to tide them over.`;
  const { embedding } = await fetchEmbedding(memText);
  await ctx.runMutation(internal.agent.memory.insertMemory, {
    agentId: args.agent.id,
    playerId: args.player.id,
    description: memText,
    importance: 6,
    lastAccess: now,
    data: { type: 'thought' },
    embedding,
  });
  await finishWithActivity(
    ctx,
    args,
    gift ? `helping ${who.name} out` : `lending ${who.name} a hand`,
    gift ? '🎁' : '🪙',
    now,
    18_000,
  );
  return true;
}

// v2.0 — at the end of a conversation, see if the two of them made a concrete plan, and if so
// write ONE shared row both attendees read from (plus a memory for each, so it surfaces in
// recall). Runs from only one side of the conversation (the lexicographically-smaller player) so
// a single gathering doesn't get logged twice. Best-effort; quietly does nothing on no-plan.
// v2.6 — conversation-driven persuasion on the live civic issue. If I hold a side and the person I
// just talked with is on a DIFFERENT side (or undecided), I nudge their stance toward mine — scaled
// by how much THEY trust me (the gossip credibility model). This is what makes "they convinced each
// other before the vote" happen in actual talk, moving the real tally.
async function maybeSwayOnConversation(ctx: any, args: any): Promise<void> {
  const mine = await ctx.runQuery(internal.civics.issueForPlayer, {
    worldId: args.worldId,
    playerId: args.playerId,
  });
  if (!mine || mine.myStance === 'undecided') return;

  const messages = await ctx.runQuery(api.messages.listMessages, {
    worldId: args.worldId,
    conversationId: args.conversationId,
  });
  if (!messages || messages.length < 2) return;
  const speakerIds = [...new Set(messages.map((m: any) => m.author))] as string[];
  if (speakerIds.length !== 2 || !speakerIds.includes(args.playerId)) return;
  const otherId = speakerIds.find((id) => id !== args.playerId)!;

  // Only persuade where there's something to move: a different side, or someone still undecided.
  const theirs = await ctx.runQuery(internal.civics.issueForPlayer, {
    worldId: args.worldId,
    playerId: otherId,
  });
  if (!theirs || theirs.myStance === mine.myStance) return;

  // Their trust in me sets how much I move them.
  const theirRels = (await ctx.runQuery(api.relationships.getRelationships, {
    worldId: args.worldId,
    playerId: otherId,
  })) as { toPlayerId: string; trust: number }[];
  const trustInMe = theirRels.find((r) => r.toPlayerId === args.playerId)?.trust ?? 50;
  await ctx.runMutation(internal.civics.lobby, {
    worldId: args.worldId,
    issueId: mine.issueId,
    lobbyistPlayerId: args.playerId,
    targetPlayerId: otherId,
    credibility: gossipCredibility(trustInMe),
  });
}

async function maybeFormPlan(ctx: any, args: any): Promise<void> {
  const messages = await ctx.runQuery(api.messages.listMessages, {
    worldId: args.worldId,
    conversationId: args.conversationId,
  });
  if (!messages || messages.length < MIN_MESSAGES_FOR_PLAN) return;

  // Only handle the two-person case, and run detection from exactly one side.
  const speakerIds = [...new Set(messages.map((m: any) => m.author))] as string[];
  if (speakerIds.length !== 2 || !speakerIds.includes(args.playerId)) return;
  const otherId = speakerIds.find((id) => id !== args.playerId)!;
  if (String(args.playerId) > String(otherId)) return; // the other side will handle it

  const participants = await ctx.runQuery(internal.aiTown.agentOperations.participantAgents, {
    worldId: args.worldId,
    playerIds: speakerIds,
  });
  const self = participants.find((p: any) => p.playerId === args.playerId);
  const other = participants.find((p: any) => p.playerId === otherId);
  if (!self || !other) return;

  const now = Date.now();
  const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, {
    worldId: args.worldId,
    playerId: args.playerId,
  });
  if (cc && now - cc.lastPlanAt < PLAN_DETECT_COOLDOWN_MS) return;

  const time: WorldTime = await ctx.runQuery(internal.clock.currentTime, {
    worldId: args.worldId,
  });
  const transcript = messages.map((m: any) => `${m.authorName}: ${m.text}`).join('\n');
  const plan = await detectPlan({
    nameA: self.name,
    nameB: other.name,
    transcript,
    places: Places.map((p) => p.name),
    maxDays: MAX_PLAN_LOOKAHEAD_DAYS,
  });
  if (!plan) return;
  const offset = clampPlanOffset(plan.dayOffset);
  if (offset === null) return;
  const planDay = time.day + offset;

  await ctx.runMutation(internal.plans.createPlan, {
    worldId: args.worldId,
    title: plan.title,
    day: planDay,
    // Keep an agreed time, but nudge a dead-of-night time onto a normal evening hour (v2.3).
    hour: plan.hour != null ? sensiblePlanHour(plan.hour) : undefined,
    placeName: plan.place,
    hostPlayerId: self.playerId,
    hostName: self.name,
    attendees: [
      { playerId: self.playerId, playerName: self.name },
      { playerId: other.playerId, playerName: other.name },
    ],
    createdDay: time.day,
  });

  // A memory for each, so the plan can surface in recall + nightly reflection too.
  const whenLabel = planWhenLabel(
    planDay,
    time.day,
    plan.hour != null ? sensiblePlanHour(plan.hour) : undefined,
  );
  const where = plan.place ? ` at ${plan.place}` : '';
  for (const [me, them] of [
    [self, other],
    [other, self],
  ] as const) {
    const memText = `${me.name === self.name ? 'I' : me.name} made plans with ${them.name} — ${plan.title}${where}, ${whenLabel} (day ${planDay}).`;
    const { embedding } = await fetchEmbedding(memText);
    await ctx.runMutation(internal.agent.memory.insertMemory, {
      agentId: me.agentId,
      playerId: me.playerId,
      description: `Plans with ${them.name}: ${plan.title}${where}, ${whenLabel} (day ${planDay}).`,
      importance: 7,
      lastAccess: now,
      data: { type: 'thought' },
      embedding,
    });
  }

  await ctx.runMutation(internal.aiTown.agentComms.recordPlan, {
    worldId: args.worldId,
    playerId: args.playerId,
    at: now,
  });
  await ctx.runMutation(internal.townLog.recordEvent, {
    worldId: args.worldId,
    kind: 'conversation',
    summary: `${self.name} and ${other.name} made plans: ${plan.title} (${whenLabel})`,
    playerId: self.playerId,
    playerName: self.name,
    subjectName: other.name,
    emoji: '📅',
  });
}

// Resolve display name + agentId for a set of players in one shot (used by plan-forming).
export const participantAgents = internalQuery({
  args: { worldId: v.id('worlds'), playerIds: v.array(playerId) },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) return [];
    const out: { playerId: string; name: string; agentId: string }[] = [];
    for (const pid of args.playerIds) {
      const agent = world.agents.find((a) => a.playerId === pid);
      if (!agent) continue;
      const desc = await ctx.db
        .query('playerDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', pid))
        .first();
      if (desc) out.push({ playerId: pid, name: desc.name, agentId: agent.id });
    }
    return out;
  },
});

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
