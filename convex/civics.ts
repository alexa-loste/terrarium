import { v } from 'convex/values';
import { internal } from './_generated/api';
import { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, query } from './_generated/server';
import { playerId } from './aiTown/ids';
import {
  initialStance,
  isWinner,
  outcomeHeadline,
  persuade,
  propositionFor,
  Stance,
  stanceLabel,
  tally,
  topicReproposable,
} from '../data/civics';
import { areRivals, priorPole } from '../data/factions';
import { costOfLivingFor } from '../data/economy';
import { getTraitsByPlayer } from './agentTraits';
import { deadPlayerIds } from './lifecycle';

// Terrarium v2.6 — CIVIC OUTCOMES storage + resolution. The thin Convex layer; the dynamics
// (stance derivation, persuasion, tally) are pure in data/civics.ts.

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

// Everyone in town who is ALIVE. This is the one roster enumerator in the codebase where that
// distinction is load-bearing: `cast` decides who takes a stance on a new civic issue and who
// feels the material effect when one passes, and the dead should do neither.
//
// The other ~13 playerDescriptions lookups are single-player name resolutions and MUST keep
// returning the dead — the survivors' memory pipeline resolves a dead character's name through
// exactly those. The remaining `.collect()` sites are one-shot seeders and the engine's world
// load, where filtering would be wrong or pointless. That was checked site by site rather than
// swept, because a name that stops resolving breaks the living, not the dead.
async function cast(ctx: any, worldId: Id<'worlds'>): Promise<Doc<'playerDescriptions'>[]> {
  const all = await ctx.db
    .query('playerDescriptions')
    .withIndex('worldId', (q: any) => q.eq('worldId', worldId))
    .collect();
  const dead = await deadPlayerIds(ctx, worldId);
  return all.filter((d: Doc<'playerDescriptions'>) => !dead.has(String(d.playerId)));
}

async function activeIssueDoc(ctx: any, worldId: Id<'worlds'>): Promise<Doc<'civicIssues'> | null> {
  const open = await ctx.db
    .query('civicIssues')
    .withIndex('byStatus', (q: any) => q.eq('worldId', worldId).eq('status', 'campaigning'))
    .collect();
  return open[0] ?? null;
}

async function convictionOn(ctx: any, worldId: Id<'worlds'>, pid: string, topic: string) {
  const beliefs = await ctx.db
    .query('beliefs')
    .withIndex('author', (q: any) => q.eq('worldId', worldId).eq('playerId', pid))
    .collect();
  const hit = beliefs.find((b: Doc<'beliefs'>) => b.topic.toLowerCase() === topic.toLowerCase());
  return hit ? hit.conviction : 0;
}

async function stanceRow(ctx: any, worldId: Id<'worlds'>, issueId: Id<'civicIssues'>, pid: string) {
  return (
    await ctx.db
      .query('civicStances')
      .withIndex('byPlayer', (q: any) =>
        q.eq('worldId', worldId).eq('playerId', pid).eq('issueId', issueId),
      )
      .collect()
  )[0] as Doc<'civicStances'> | undefined;
}

// ── open an issue ────────────────────────────────────────────────────────────────────────────────

// A faction puts a proposition forward (only if none is currently campaigning). Seeds every
// character's opening stance from their belief side + faction alignment.
export const openIssue = internalMutation({
  args: {
    worldId: v.id('worlds'),
    topic: v.string(),
    proposerPlayerId: playerId,
    proposerName: v.string(),
    proposerFactionId: v.optional(v.id('factions')),
    openedDay: v.number(),
  },
  handler: async (ctx, args) => {
    if (await activeIssueDoc(ctx, args.worldId)) return { issueId: null, opened: false };
    const prop = propositionFor(args.topic);
    if (!prop) return { issueId: null, opened: false };

    // v2.8 — don't re-litigate a settled proposition. A passed one is enacted (locked); a failed
    // one gets a cooldown before anyone can bring it back. (Stops the proposer-loops-forever bug.)
    const priorResolved = (
      await ctx.db
        .query('civicIssues')
        .withIndex('byStatus', (q: any) => q.eq('worldId', args.worldId).eq('status', 'resolved'))
        .collect()
    )
      .filter((i: Doc<'civicIssues'>) => i.topic === args.topic)
      .sort((a: Doc<'civicIssues'>, b: Doc<'civicIssues'>) => (b.resolvedDay ?? 0) - (a.resolvedDay ?? 0));
    const latest = priorResolved[0];
    if (
      !topicReproposable(
        latest ? { passed: !!latest.passed, resolvedDay: latest.resolvedDay ?? 0 } : null,
        args.openedDay,
      )
    ) {
      return { issueId: null, opened: false };
    }
    const now = Date.now();

    // Find the proposing faction + its rival (same topic, opposite pole) to seed faction alignment.
    const proposerFaction = args.proposerFactionId
      ? await ctx.db.get(args.proposerFactionId)
      : null;
    const allFactions = (
      await ctx.db
        .query('factions')
        .withIndex('worldId', (q: any) => q.eq('worldId', args.worldId))
        .collect()
    ).filter((f: Doc<'factions'>) => f.status === 'active');
    const rivalFaction =
      proposerFaction != null
        ? allFactions.find((f: Doc<'factions'>) => areRivals(proposerFaction, f)) ?? null
        : null;

    const memberIds = async (factionId: Id<'factions'> | undefined) => {
      if (!factionId) return new Set<string>();
      const ties = await ctx.db
        .query('factionTies')
        .withIndex('byFaction', (q: any) => q.eq('worldId', args.worldId).eq('factionId', factionId))
        .collect();
      return new Set(ties.filter((t: Doc<'factionTies'>) => t.commitment >= 50).map((t: any) => String(t.playerId)));
    };
    const proposerMembers = await memberIds(args.proposerFactionId);
    const rivalMembers = await memberIds(rivalFaction?._id);

    const issueId = await ctx.db.insert('civicIssues', {
      worldId: args.worldId,
      topic: args.topic,
      favorsPole: prop.favorsPole,
      title: prop.title,
      text: prop.text,
      proposerPlayerId: args.proposerPlayerId,
      proposerName: args.proposerName,
      proposerFactionId: args.proposerFactionId,
      openedDay: args.openedDay,
      resolvesDay: args.openedDay + 3, // CIVIC_CAMPAIGN_DAYS
      status: 'campaigning',
      createdAt: now,
    });

    const traitsByPlayer = await getTraitsByPlayer(ctx, args.worldId);
    for (const d of await cast(ctx, args.worldId)) {
      const pid = String(d.playerId);
      const conv = await convictionOn(ctx, args.worldId, pid, args.topic);
      const factionAlignment = proposerMembers.has(pid) ? 1 : rivalMembers.has(pid) ? -1 : 0;
      const { stance, weight } = initialStance(
        priorPole(d.name, args.topic, traitsByPlayer.get(pid)),
        conv,
        prop,
        factionAlignment as 0 | 1 | -1,
      );
      await ctx.db.insert('civicStances', {
        worldId: args.worldId,
        issueId,
        playerId: d.playerId,
        playerName: d.name,
        stance,
        weight,
        updatedAt: now,
      });
    }

    await ctx.db.insert('townEvents', {
      worldId: args.worldId,
      ts: now,
      kind: 'system',
      playerId: args.proposerPlayerId,
      playerName: args.proposerName,
      emoji: '🏛️',
      summary: `${args.proposerName} put the ${prop.title} to the town — it'll be decided in 3 days.`,
    });
    return { issueId, opened: true };
  },
});

// ── lobby / persuade ─────────────────────────────────────────────────────────────────────────────

export const lobby = internalMutation({
  args: {
    worldId: v.id('worlds'),
    issueId: v.id('civicIssues'),
    lobbyistPlayerId: playerId,
    targetPlayerId: playerId,
    credibility: v.number(),
  },
  handler: async (ctx, args) => {
    const issue = await ctx.db.get(args.issueId);
    if (!issue || issue.status !== 'campaigning') return { moved: false };
    const lob = await stanceRow(ctx, args.worldId, args.issueId, String(args.lobbyistPlayerId));
    const tgt = await stanceRow(ctx, args.worldId, args.issueId, String(args.targetPlayerId));
    if (!lob || !tgt || lob.stance === 'undecided') return { moved: false };
    const next = persuade(
      { stance: tgt.stance as Stance, weight: tgt.weight },
      lob.stance as Stance,
      lob.weight,
      args.credibility,
    );
    if (next.stance === tgt.stance && Math.abs(next.weight - tgt.weight) < 0.5) return { moved: false };
    await ctx.db.patch(tgt._id, { stance: next.stance, weight: next.weight, updatedAt: Date.now() });
    return { moved: true, stance: next.stance };
  },
});

// ── resolve ──────────────────────────────────────────────────────────────────────────────────────

// Tally the campaign and land the outcome on everyone: winners get vindicated (momentum up, stress
// down) and losers feel the loss (stress up); the proposing faction consolidates or frays; the
// winning side's conviction firms; and a one-time material effect lands if it passed.
export const resolveDue = internalMutation({
  args: { worldId: v.id('worlds'), currentDay: v.number() },
  handler: async (ctx, args) => {
    const issue = await activeIssueDoc(ctx, args.worldId);
    if (!issue || args.currentDay < issue.resolvesDay) return { resolved: false };
    const prop = propositionFor(issue.topic);
    if (!prop) return { resolved: false };
    const now = Date.now();

    const stances = (await ctx.db
      .query('civicStances')
      .withIndex('byIssue', (q: any) => q.eq('worldId', args.worldId).eq('issueId', issue._id))
      .collect()) as Doc<'civicStances'>[];
    const result = tally(stances.map((s) => ({ stance: s.stance as Stance, weight: s.weight })));

    await ctx.db.patch(issue._id, {
      status: 'resolved',
      passed: result.passed,
      forWeight: Math.round(result.forWeight),
      againstWeight: Math.round(result.againstWeight),
      resolvedDay: args.currentDay,
    });

    // Per-character consequences.
    for (const s of stances) {
      const won = isWinner(s.stance as Stance, result.passed);
      if (won == null) continue; // undecided — sat it out
      const vit = await ctx.db
        .query('agentVitals')
        .withIndex('playerId', (q: any) => q.eq('worldId', args.worldId).eq('playerId', s.playerId))
        .first();
      if (vit) {
        const stress = clamp((vit.stress ?? 25) + (won ? -5 : 8));
        const momentum = clamp((vit.momentum ?? 50) + (won ? 6 : -4));
        await ctx.db.patch(vit._id, { stress, momentum });
      }
      // The result firms the winners' conviction a touch (lived vindication).
      if (won) {
        await ctx.runMutation(internal.beliefs.nudgeBelief, {
          worldId: args.worldId,
          playerId: s.playerId,
          topic: issue.topic,
          delta: 2,
        });
      }
    }

    // Faction consequence: the proposing bloc consolidates on a win, frays on a loss.
    if (issue.proposerFactionId) {
      const faction = await ctx.db.get(issue.proposerFactionId);
      if (faction && faction.status === 'active') {
        await ctx.db.patch(faction._id, {
          intensity: clamp(faction.intensity + (result.passed ? 6 : -5)),
        });
        const ties = await ctx.db
          .query('factionTies')
          .withIndex('byFaction', (q: any) =>
            q.eq('worldId', args.worldId).eq('factionId', faction._id),
          )
          .collect();
        for (const t of ties as Doc<'factionTies'>[]) {
          if (t.role === 'founder') continue;
          await ctx.db.patch(t._id, {
            commitment: clamp(t.commitment + (result.passed ? 8 : -10)),
            updatedAt: now,
          });
        }
      }
    }

    // One-time MATERIAL effect on a pass — the outcome isn't just status, it touches lives.
    if (result.passed) {
      const traitsByPlayer = await getTraitsByPlayer(ctx, args.worldId);
      for (const d of await cast(ctx, args.worldId)) {
        const vit = await ctx.db
          .query('agentVitals')
          .withIndex('playerId', (q: any) => q.eq('worldId', args.worldId).eq('playerId', d.playerId))
          .first();
        if (!vit) continue;
        let dStress = 0;
        let dLeisure = 0;
        if (issue.topic === 'automation' && costOfLivingFor(d.name) <= 25) {
          dStress = -6; // the transition fund eases those living closest to the edge
          dLeisure = 6;
        } else if (
          issue.topic === 'regulation' &&
          priorPole(d.name, 'regulation', traitsByPlayer.get(String(d.playerId))) === -1
        ) {
          dStress = 6; // the ordinance constrains the builder-freedom side
        } else if (
          issue.topic === 'AI safety' &&
          priorPole(d.name, 'AI safety', traitsByPlayer.get(String(d.playerId))) === -1
        ) {
          dStress = 5; // a brake on the fastest movers
        }
        if (dStress || dLeisure) {
          await ctx.db.patch(vit._id, {
            stress: clamp((vit.stress ?? 25) + dStress),
            leisure: clamp((vit.leisure ?? 60) + dLeisure),
          });
        }
      }
    }

    await ctx.db.insert('townEvents', {
      worldId: args.worldId,
      ts: now,
      kind: 'system',
      emoji: result.passed ? '✅' : '❌',
      summary: outcomeHeadline(prop, result.passed),
    });
    return {
      resolved: true,
      passed: result.passed,
      headline: outcomeHeadline(prop, result.passed),
      title: prop.title,
    };
  },
});

// ── reads ────────────────────────────────────────────────────────────────────────────────────────

// The live issue + the current tally + everyone's stance — for the town civic panel.
export const activeIssue = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const issue = await activeIssueDoc(ctx, args.worldId);
    if (!issue) return null;
    const stances = (await ctx.db
      .query('civicStances')
      .withIndex('byIssue', (q: any) => q.eq('worldId', args.worldId).eq('issueId', issue._id))
      .collect()) as Doc<'civicStances'>[];
    const t = tally(stances.map((s) => ({ stance: s.stance as Stance, weight: s.weight })));
    return {
      issueId: issue._id,
      title: issue.title,
      text: issue.text,
      proposerName: issue.proposerName,
      openedDay: issue.openedDay,
      resolvesDay: issue.resolvesDay,
      forWeight: Math.round(t.forWeight),
      againstWeight: Math.round(t.againstWeight),
      supporters: t.supporters,
      opposers: t.opposers,
      leaning: t.forWeight === t.againstWeight ? 'tied' : t.passed ? 'passing' : 'failing',
      stances: stances
        .sort((a, b) => b.weight - a.weight)
        .map((s) => ({ name: s.playerName, stance: s.stance, weight: Math.round(s.weight) })),
    };
  },
});

// The most recently resolved issue (for a short "what the town decided" history line).
export const lastResolved = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const resolved = (
      await ctx.db
        .query('civicIssues')
        .withIndex('byStatus', (q: any) => q.eq('worldId', args.worldId).eq('status', 'resolved'))
        .collect()
    ).sort((a: Doc<'civicIssues'>, b: Doc<'civicIssues'>) => (b.resolvedDay ?? 0) - (a.resolvedDay ?? 0));
    const last = resolved[0];
    if (!last) return null;
    return { title: last.title, passed: !!last.passed, resolvedDay: last.resolvedDay ?? 0 };
  },
});

// For the prompt + campaign logic: the live issue and this character's stance on it.
export const issueForPlayer = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const issue = await activeIssueDoc(ctx, args.worldId);
    if (!issue) return null;
    const prop = propositionFor(issue.topic);
    if (!prop) return null;
    const mine = await stanceRow(ctx, args.worldId, issue._id, String(args.playerId));
    return {
      issueId: issue._id,
      topic: issue.topic,
      title: issue.title,
      text: issue.text,
      proposerName: issue.proposerName,
      resolvesDay: issue.resolvesDay,
      myStance: (mine?.stance ?? 'undecided') as Stance,
      myWeight: mine?.weight ?? 0,
      myStanceLabel: stanceLabel((mine?.stance ?? 'undecided') as Stance, prop),
    };
  },
});

// Has any faction-anchored topic; used by maybeProposeIssue to find a topic with a faction behind it.
export const noActiveIssue = internalQuery({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    return (await activeIssueDoc(ctx, args.worldId)) == null;
  },
});
