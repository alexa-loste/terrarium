import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from './_generated/server';
import { playerId } from './aiTown/ids';
import { PLAN_VISIBLE_WITHIN_DAYS } from '../data/plans';
import { gatheringHourFor } from '../data/work';
import { getTraitsByPlayer } from './agentTraits';

// v2.3 one-off — give already-scheduled gatherings (created before time-of-day existed) a sensible
// evening hour after the host's shift, so they read "in 2 days at 19:00" like new ones do.
export const backfillGatheringHours = internalMutation({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('plannedEvents')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    let patched = 0;
    const traitsByPlayer = await getTraitsByPlayer(ctx, args.worldId);
    for (const r of rows) {
      if (r.status !== 'upcoming' || typeof r.hour === 'number') continue;
      if (r.kind !== 'gathering') continue; // pair-plans can stay open-time by design
      await ctx.db.patch(r._id, {
        hour: gatheringHourFor(
          r.hostName,
          Math.random(),
          traitsByPlayer.get(String(r.hostPlayerId)),
        ),
      });
      patched++;
    }
    return patched;
  },
});

// v2.0 — the shared-plans store. One row per gathering, anchored to an absolute world-day, with
// every attendee listed. The point is a SINGLE source of truth both participants read from, so
// they're genuinely on the same page instead of each half-remembering it in lossy vector memory.

const attendee = v.object({ playerId, playerName: v.string() });

// Loose title match so "coffee at the cafe" and "grab coffee" made the same day by the same
// host don't become two rows.
function titlesOverlap(a: string, b: string): boolean {
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const sa = norm(a);
  const sb = norm(b);
  if (!sa.size || !sb.size) return false;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared >= Math.min(2, Math.min(sa.size, sb.size));
}

// Create a shared plan — or, if the same host already has a near-identical upcoming gathering
// on that day, just fold the new attendees into it. Returns the row id.
export const createPlan = internalMutation({
  args: {
    worldId: v.id('worlds'),
    title: v.string(),
    description: v.optional(v.string()),
    day: v.number(),
    hour: v.optional(v.number()),
    placeName: v.optional(v.string()),
    hostPlayerId: playerId,
    hostName: v.string(),
    attendees: v.array(attendee),
    createdDay: v.number(),
  },
  handler: async (ctx, args) => {
    const sameDay = await ctx.db
      .query('plannedEvents')
      .withIndex('byDay', (q) => q.eq('worldId', args.worldId).eq('day', args.day))
      .collect();
    const dup = sameDay.find(
      (p) =>
        p.status === 'upcoming' &&
        p.hostPlayerId === args.hostPlayerId &&
        titlesOverlap(p.title, args.title),
    );
    if (dup) {
      const known = new Set(dup.attendees.map((a) => a.playerId));
      const merged = [...dup.attendees];
      for (const a of args.attendees) if (!known.has(a.playerId)) merged.push(a);
      if (merged.length !== dup.attendees.length) {
        await ctx.db.patch(dup._id, { attendees: merged });
      }
      return dup._id;
    }
    return await ctx.db.insert('plannedEvents', {
      worldId: args.worldId,
      title: args.title,
      description: args.description,
      day: args.day,
      hour: args.hour,
      placeName: args.placeName,
      hostPlayerId: args.hostPlayerId,
      hostName: args.hostName,
      attendees: args.attendees,
      createdDay: args.createdDay,
      status: 'upcoming',
      createdAt: Date.now(),
    });
  },
});

// Add one more attendee to an existing gathering (e.g. someone heard about it and opted in).
export const joinPlan = internalMutation({
  args: { planId: v.id('plannedEvents'), playerId, playerName: v.string() },
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (!plan || plan.status !== 'upcoming') return;
    if (plan.attendees.some((a) => a.playerId === args.playerId)) return;
    await ctx.db.patch(args.planId, {
      attendees: [...plan.attendees, { playerId: args.playerId, playerName: args.playerName }],
    });
  },
});

// For prompt injection: the gatherings this player is part of that are coming up SOON (within
// the visible horizon and not yet past). This is what makes them act on the plan.
export const upcomingForPlayer = internalQuery({
  args: { worldId: v.id('worlds'), playerId, currentDay: v.number() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query('plannedEvents')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    return all
      .filter(
        (p) =>
          p.status === 'upcoming' &&
          p.day >= args.currentDay &&
          p.day - args.currentDay <= PLAN_VISIBLE_WITHIN_DAYS &&
          p.attendees.some((a) => a.playerId === args.playerId),
      )
      .sort((a, b) => a.day - b.day)
      .map((p) => ({
        title: p.title,
        day: p.day,
        hour: p.hour,
        placeName: p.placeName,
        hostName: p.hostName,
        attendees: p.attendees.map((a) => a.playerName),
      }));
  },
});

// Housekeeping: once a gathering's day has passed, flip it out of 'upcoming'. Called from the
// nightly evaluation. We don't track attendance yet, so everything past reads as 'happened'.
export const sweepPast = internalMutation({
  args: { worldId: v.id('worlds'), currentDay: v.number() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query('plannedEvents')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    for (const p of all) {
      // Gatherings are retired by resolveDueGatherings (which also applies influence); leave them.
      if (p.kind === 'gathering') continue;
      if (p.status === 'upcoming' && p.day < args.currentDay) {
        await ctx.db.patch(p._id, { status: 'happened' });
      }
    }
  },
});

// For the UI: every plan a player is host of or invited to, newest-landing first.
export const getForPlayer = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query('plannedEvents')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    return all
      .filter((p) => p.attendees.some((a) => a.playerId === args.playerId))
      .sort((a, b) => (a.status === b.status ? a.day - b.day : a.status === 'upcoming' ? -1 : 1));
  },
});

// For a town-wide calendar view: all upcoming gatherings.
export const listUpcoming = query({
  args: { worldId: v.id('worlds'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query('plannedEvents')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    return all
      .filter((p) => p.status === 'upcoming')
      .sort((a, b) => a.day - b.day)
      .slice(0, args.limit ?? 30);
  },
});

// ---------------------------------------------------------------------------------------------
// v2.1 — GROUP GATHERINGS as the influence vector.
//
// A 'gathering' (vs a 'pair' plan) is an OPEN event a host throws that anyone can join. When it
// lands and people showed, the HOST gains standing (attendees' respect/warmth flow to them) and
// everyone present gets a leisure/social/momentum lift. Hosting events people come to is how a
// character grows influence in town — the soft, non-zero-sum kind alexa asked for.
// ---------------------------------------------------------------------------------------------

// A host throws an open gathering. They start as the sole attendee; others opt in via joinPlan.
export const proposeGathering = internalMutation({
  args: {
    worldId: v.id('worlds'),
    title: v.string(),
    description: v.optional(v.string()),
    day: v.number(),
    hour: v.optional(v.number()),
    placeName: v.optional(v.string()),
    hostPlayerId: playerId,
    hostName: v.string(),
    createdDay: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('plannedEvents', {
      worldId: args.worldId,
      title: args.title,
      description: args.description,
      day: args.day,
      hour: args.hour,
      placeName: args.placeName,
      hostPlayerId: args.hostPlayerId,
      hostName: args.hostName,
      attendees: [{ playerId: args.hostPlayerId, playerName: args.hostName }],
      createdDay: args.createdDay,
      status: 'upcoming',
      kind: 'gathering',
      createdAt: Date.now(),
    });
  },
});

// Open gatherings this player could still join — upcoming, hosted by someone else, not already in.
export const openGatheringsToJoin = internalQuery({
  args: { worldId: v.id('worlds'), playerId, currentDay: v.number() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query('plannedEvents')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    return all
      .filter(
        (p) =>
          p.kind === 'gathering' &&
          p.status === 'upcoming' &&
          p.day >= args.currentDay &&
          p.hostPlayerId !== args.playerId &&
          !p.attendees.some((a) => a.playerId === args.playerId),
      )
      .sort((a, b) => a.day - b.day)
      .map((p) => ({
        id: p._id,
        title: p.title,
        description: p.description,
        day: p.day,
        placeName: p.placeName,
        hostName: p.hostName,
        attendeeNames: p.attendees.map((a) => a.playerName),
      }));
  },
});

// How many open gatherings this host already has on the books (so they don't spam events).
export const upcomingHostedBy = internalQuery({
  args: { worldId: v.id('worlds'), playerId, currentDay: v.number() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query('plannedEvents')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    return all.filter(
      (p) =>
        p.kind === 'gathering' &&
        p.status === 'upcoming' &&
        p.hostPlayerId === args.playerId &&
        p.day >= args.currentDay,
    ).length;
  },
});

// v2.8 — the gatherings happening TODAY that this player is committed to (host or RSVP'd), so the
// agent loop knows to physically head to the venue when the hour comes. Open-time pair plans are
// excluded (no fixed hour to show up for); only hosted gatherings gate physical attendance.
export const gatheringsTodayFor = internalQuery({
  args: { worldId: v.id('worlds'), playerId, currentDay: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('plannedEvents')
      .withIndex('byDay', (q) => q.eq('worldId', args.worldId).eq('day', args.currentDay))
      .collect();
    return rows
      .filter(
        (p) =>
          p.kind === 'gathering' &&
          p.status === 'upcoming' &&
          typeof p.hour === 'number' &&
          !!p.placeName &&
          p.attendees.some((a) => a.playerId === args.playerId),
      )
      .map((p) => ({
        planId: p._id,
        title: p.title,
        hour: p.hour as number,
        placeName: p.placeName as string,
        isHost: p.hostPlayerId === args.playerId,
        alreadyPresent: (p.present ?? []).some((a) => a.playerId === args.playerId),
      }));
  },
});

// v2.8 — record that a player PHYSICALLY reached the venue during the event window. Idempotent:
// adding someone already present is a no-op, so repeated ticks at the venue don't double-count.
export const markPresent = internalMutation({
  args: { worldId: v.id('worlds'), planId: v.id('plannedEvents'), playerId, playerName: v.string() },
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (!plan || plan.status !== 'upcoming') return { added: false };
    const present = plan.present ?? [];
    if (present.some((a) => a.playerId === args.playerId)) return { added: false };
    await ctx.db.patch(args.planId, {
      present: [...present, { playerId: args.playerId, playerName: args.playerName }],
    });
    return { added: true };
  },
});

// Resolve every gathering whose day has arrived: apply the influence flows and mark it happened.
// Idempotent — flipping status means re-calls (multiple agents tick at night) are no-ops.
export const resolveDueGatherings = internalMutation({
  args: { worldId: v.id('worlds'), currentDay: v.number() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query('plannedEvents')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    const due = all.filter(
      (p) => p.kind === 'gathering' && p.status === 'upcoming' && p.day <= args.currentDay,
    );
    const bump = async (pid: string, patch: (v: any) => any) => {
      const row = await ctx.db
        .query('agentVitals')
        .withIndex('playerId', (q) => q.eq('worldId', args.worldId).eq('playerId', pid))
        .first();
      if (row) await ctx.db.patch(row._id, patch(row));
    };
    const clamp = (n: number) => Math.max(0, Math.min(100, n));

    for (const g of due) {
      // v2.8 — turnout is who PHYSICALLY showed (present), not who RSVP'd (attendees). Pre-v2.8
      // rows have no `present` field; fall back to the RSVP list so in-flight events don't all flop.
      const present = g.present ?? g.attendees;
      const turnout = present.length;
      // A gathering nobody but the host committed to is a flop — small sting, no influence.
      if (turnout <= 1) {
        await bump(g.hostPlayerId, (v) => ({ momentum: clamp((v.momentum ?? 50) - 4) }));
        await ctx.db.patch(g._id, { status: 'happened', turnout });
        await ctx.db.insert('townEvents', {
          worldId: args.worldId,
          ts: Date.now(),
          kind: 'system',
          playerName: g.hostName,
          emoji: '📅',
          summary: `${g.hostName}'s "${g.title}" came and went — almost no one showed.`,
        });
        continue;
      }
      // Everyone present gets a lift: time among people, a lighter head, a bit of momentum.
      for (const a of present) {
        await bump(a.playerId, (v) => ({
          leisure: clamp((v.leisure ?? 60) + 18),
          social: clamp((v.social ?? 60) + 15),
          momentum: clamp((v.momentum ?? 50) + 4),
        }));
        // Standing flows TO the host: attendees leave warmer to, and more impressed by, them.
        if (a.playerId !== g.hostPlayerId) {
          const edge = await ctx.db
            .query('relationships')
            .withIndex('edge', (q) =>
              q
                .eq('worldId', args.worldId)
                .eq('fromPlayerId', a.playerId)
                .eq('toPlayerId', g.hostPlayerId),
            )
            .first();
          const base = edge ?? {
            familiarity: 30,
            affinity: 50,
            respect: 50,
            trust: 50,
            romantic: 0,
          };
          const next = {
            familiarity: clamp(base.familiarity + 4),
            affinity: clamp(base.affinity + 4),
            respect: clamp(base.respect + 6),
            trust: base.trust,
            romantic: base.romantic,
            updatedAt: Date.now(),
          };
          if (edge) await ctx.db.patch(edge._id, next);
          else
            await ctx.db.insert('relationships', {
              worldId: args.worldId,
              fromPlayerId: a.playerId,
              toPlayerId: g.hostPlayerId,
              ...next,
            });
        }
      }
      // The host's payoff scales with turnout — a well-attended event you threw feels like winning.
      await bump(g.hostPlayerId, (v) => ({
        momentum: clamp((v.momentum ?? 50) + 6 + Math.min(turnout, 5) * 2),
      }));
      await ctx.db.patch(g._id, { status: 'happened', turnout });
      await ctx.db.insert('townEvents', {
        worldId: args.worldId,
        ts: Date.now(),
        kind: 'relationship',
        playerName: g.hostName,
        emoji: '🎉',
        summary: `${g.hostName} hosted "${g.title}" — ${turnout} came. Their standing in town grew.`,
      });
    }
    return { resolved: due.length };
  },
});
