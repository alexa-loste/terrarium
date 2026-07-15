// Terrarium v2.10 — SOCIETY VITALS (the evolution-instrument readout half).
//
// One read-only snapshot of the whole society's MACRO-state, computed from the tables that
// already exist. It answers a single question: "what state is this society in right now?" —
// as a vector of aggregate scalars rather than a wall of individual rows.
//
// Why this first (per pith's evolution read, 2026-06-16): before we can ask whether the society
// can EVOLVE — whether two runs from near-identical starts fan out or wash back to the same
// equilibrium — we need a cheap, deterministic way to MEASURE the society's state at a point in
// time. This is that measurement. Diff two snapshots (two forks, or the same world across days)
// and the deltas tell you whether anything actually moved. It also doubles as a live dashboard.
//
// It is deliberately a plain `query` (not internal) so you can run it straight from the CLI:
//   npx convex run vitals:snapshot           # the default world
//   npx convex run vitals:snapshot '{"worldId":"..."}'
//
// The metrics that matter most for the divergence question are the INEQUALITY / POLARIZATION
// indices (wealth Gini, reputation spread, faction balance) — those are the dimensions a
// homeostatic society keeps flat and a divergence-generating one lets fan out. The rest is
// texture: mood weather, relationship warmth, civic + reciprocity activity.
//
// Pure, dependency-free; touches no engine state. See convex/schema.ts for every table read.

import { v } from 'convex/values';
import { query } from './_generated/server';
import { seedBeliefsFor } from '../data/beliefs';

// ---- small stats helpers (pure) ---------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Gini coefficient (0 = perfect equality, →1 = one holder owns everything). The single best
// scalar for "how unequally is this distributed" — used for wealth and for reputation/status.
// Negative values are clamped to 0 so a stray negative balance can't break the formula.
function gini(xs: number[]): number {
  const v = xs.map((x) => Math.max(0, x));
  const n = v.length;
  if (n === 0) return 0;
  const total = v.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const sorted = [...v].sort((a, b) => a - b);
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * sorted[i];
  // standard discrete Gini
  return (2 * cum) / (n * total) - (n + 1) / n;
}

function round(x: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

// Mean over an optional numeric field, ignoring rows where it's absent.
function meanOf<T>(rows: T[], pick: (r: T) => number | undefined): number {
  const xs = rows.map(pick).filter((x): x is number => typeof x === 'number');
  return round(mean(xs), 1);
}

// ---- the snapshot -----------------------------------------------------------------------------

export const snapshot = query({
  args: { worldId: v.optional(v.id('worlds')) },
  handler: async (ctx, args) => {
    // Resolve the world: explicit arg, else the default world.
    let worldId = args.worldId;
    if (!worldId) {
      const def = await ctx.db
        .query('worldStatus')
        .filter((q) => q.eq(q.field('isDefault'), true))
        .first();
      if (!def) throw new Error('No default world found — pass {worldId}.');
      worldId = def.worldId;
    }
    const wid = (q: any) => q.eq('worldId', worldId);

    const clock = await ctx.db
      .query('worldClock')
      .withIndex('worldId', wid)
      .first();
    // world-day "now" implied by the clock (frozen → stands still at the anchor).
    const speed = clock ? (clock.frozen ? 0 : clock.speed) : 1;
    const worldMs = clock
      ? Math.max(0, clock.epochWorldMs + (Date.now() - clock.epochRealMs) * speed)
      : 0;
    const day = Math.floor(worldMs / (24 * 60 * 1000)) + 1;

    // ---- pull every table we aggregate (all indexed by worldId) ----
    const [
      vitals,
      beliefs,
      factions,
      ties,
      relationships,
      ledger,
      exchanges,
      issues,
      gossip,
      work,
      goals,
    ] = await Promise.all([
      ctx.db.query('agentVitals').withIndex('playerId', wid).collect(),
      ctx.db.query('beliefs').withIndex('author', wid).collect(),
      ctx.db.query('factions').withIndex('worldId', wid).collect(),
      ctx.db.query('factionTies').withIndex('byFaction', wid).collect(),
      ctx.db.query('relationships').withIndex('inbound', wid).collect(),
      ctx.db.query('reciprocityLedger').withIndex('debtor', wid).collect(),
      ctx.db.query('exchanges').withIndex('worldId', wid).collect(),
      ctx.db.query('civicIssues').withIndex('worldId', wid).collect(),
      ctx.db.query('gossipEvents').withIndex('worldId', wid).collect(),
      ctx.db.query('workState').withIndex('author', wid).collect(),
      ctx.db.query('goals').withIndex('author', wid).collect(),
    ]);

    const population = vitals.length;

    // ---- ECONOMY: wealth distribution (a primary divergence dimension) ----
    const money = vitals.map((vv) => vv.money ?? 0);
    const economy = {
      population,
      totalMoney: round(money.reduce((a, b) => a + b, 0), 0),
      meanMoney: round(mean(money), 0),
      medianMoney: round(median(money), 0),
      minMoney: round(Math.min(...(money.length ? money : [0])), 0),
      maxMoney: round(Math.max(...(money.length ? money : [0])), 0),
      wealthGini: round(gini(money), 3), // ⭐ inequality — 0 flat, →1 concentrated
    };

    // ---- BELIEF landscape: how far has conviction drifted from the seeded start? ----
    // The HONEST idea-movement metric: compare each live belief's conviction to its SEEDED
    // value (matched on character + topic). The `origin:'evolved'` counter can't move via the
    // nightly path (only addBelief sets it, and the drift loop never forms new beliefs), and
    // `lastShiftAt` only fires on a single ≥6 move — so both undercount slow drift. This delta
    // is the real "have convictions moved off where they started" reading. Beliefs with no seed
    // match are net-new (formed in-world), counted separately.
    const seedConv = (name: string, topic: string): number | undefined => {
      const t = topic.toLowerCase().trim();
      const hit = seedBeliefsFor(name).find(
        (s) =>
          s.topic.toLowerCase() === t ||
          s.topic.toLowerCase().includes(t) ||
          t.includes(s.topic.toLowerCase()),
      );
      return hit?.conviction;
    };
    const drifts: number[] = [];
    let netNew = 0;
    for (const b of beliefs) {
      const seed = seedConv(b.playerName, b.topic);
      if (seed === undefined) netNew++;
      else drifts.push(Math.abs(b.conviction - seed));
    }
    const DRIFT_EPS = 3; // a conviction move this big counts as "moved" (below it = noise)

    const byTopic: Record<string, number[]> = {};
    for (const b of beliefs) (byTopic[b.topic] ??= []).push(b.conviction);
    const beliefLandscape = {
      total: beliefs.length,
      seed: beliefs.filter((b) => b.origin === 'seed').length,
      evolved: beliefs.filter((b) => b.origin === 'evolved').length, // structurally 0 via drift path
      shifted: beliefs.filter((b) => typeof b.lastShiftAt === 'number').length, // ≥6-move flag
      // ⭐ honest idea-movement: live conviction vs seed.
      meanAbsConvictionDrift: round(mean(drifts), 1),
      maxAbsConvictionDrift: round(Math.max(0, ...(drifts.length ? drifts : [0])), 1),
      driftedFromSeed: drifts.filter((d) => d >= DRIFT_EPS).length,
      matchedToSeed: drifts.length,
      netNewBeliefs: netNew,
      meanConviction: round(mean(beliefs.map((b) => b.conviction)), 1),
      convictionStdev: round(stdev(beliefs.map((b) => b.conviction)), 1),
      byTopic: Object.entries(byTopic)
        .map(([topic, xs]) => ({
          topic,
          n: xs.length,
          meanConviction: round(mean(xs), 1),
        }))
        .sort((a, b) => b.n - a.n),
    };

    // ---- FACTIONS: the group tier + polarization ----
    const tiesByFaction: Record<string, typeof ties> = {};
    for (const t of ties) (tiesByFaction[t.factionId] ??= []).push(t);
    const factionRows = factions.map((f) => {
      const fTies = tiesByFaction[f._id] ?? [];
      const members = fTies.filter((t) => t.role === 'founder' || t.role === 'member');
      return {
        name: f.name,
        topic: f.topic,
        pole: f.pole,
        intensity: round(f.intensity, 0),
        members: members.length,
        curious: fTies.filter((t) => t.role === 'curious').length,
        meanCommitment: round(mean(fTies.map((t) => t.commitment)), 0),
      };
    });
    // Polarization: for each topic with factions on BOTH poles, how balanced × how intense are
    // the two camps. Balanced + hot = polarized; one-sided or cold = not. 0..~100.
    const topicsWithFactions: Record<string, typeof factionRows> = {};
    for (const fr of factionRows) (topicsWithFactions[fr.topic] ??= []).push(fr);
    let rivalPairs = 0;
    let polarizationScore = 0;
    for (const rows of Object.values(topicsWithFactions)) {
      const pos = rows.filter((r) => r.pole > 0);
      const neg = rows.filter((r) => r.pole < 0);
      if (pos.length && neg.length) {
        rivalPairs++;
        const sizePos = pos.reduce((a, r) => a + r.members, 0);
        const sizeNeg = neg.reduce((a, r) => a + r.members, 0);
        const balance = Math.min(sizePos, sizeNeg) / Math.max(1, Math.max(sizePos, sizeNeg));
        const heat = mean([...pos, ...neg].map((r) => r.intensity));
        polarizationScore += balance * heat;
      }
    }
    const factionTier = {
      count: factions.length,
      totalAffiliated: new Set(ties.map((t) => t.playerId)).size,
      largest: factionRows.reduce((m, r) => Math.max(m, r.members), 0),
      rivalPairs,
      polarizationScore: round(polarizationScore, 1), // ⭐ belief-camp polarization
      factions: factionRows.sort((a, b) => b.members - a.members),
    };

    // ---- RELATIONSHIP graph + reputation (status) inequality ----
    const repByPlayer: Record<string, { respect: number[]; trust: number[]; affinity: number[] }> =
      {};
    for (const r of relationships) {
      const k = r.toPlayerId as string;
      (repByPlayer[k] ??= { respect: [], trust: [], affinity: [] });
      repByPlayer[k].respect.push(r.respect);
      repByPlayer[k].trust.push(r.trust);
      repByPlayer[k].affinity.push(r.affinity);
    }
    const reputationPerPlayer = Object.values(repByPlayer).map((v) => mean(v.respect));
    const strongTies = relationships.filter((r) => r.affinity >= 65 && r.trust >= 65).length;
    const romanticEdges = relationships.filter((r) => r.romantic > 0);
    // mutual romance: both directions carry romantic feeling.
    const edgeKey = (a: string, b: string) => `${a}|${b}`;
    const romanticSet = new Set(
      romanticEdges.map((r) => edgeKey(r.fromPlayerId as string, r.toPlayerId as string)),
    );
    let mutualRomance = 0;
    for (const r of romanticEdges) {
      if (romanticSet.has(edgeKey(r.toPlayerId as string, r.fromPlayerId as string))) mutualRomance++;
    }
    const relationshipGraph = {
      edges: relationships.length,
      meanFamiliarity: round(mean(relationships.map((r) => r.familiarity)), 1),
      meanAffinity: round(mean(relationships.map((r) => r.affinity)), 1),
      meanRespect: round(mean(relationships.map((r) => r.respect)), 1),
      meanTrust: round(mean(relationships.map((r) => r.trust)), 1),
      strongTies, // affinity & trust both ≥ 65
      romanticEdges: romanticEdges.length,
      mutualRomancePairs: round(mutualRomance / 2, 0),
      reputationGini: round(gini(reputationPerPlayer), 3), // ⭐ status inequality
      reputationSpread: round(stdev(reputationPerPlayer), 1),
    };

    // ---- RECIPROCITY: the horizontal economy ----
    const debts = ledger.filter((l) => l.moneyDebt > 0);
    const reciprocity = {
      activeDebtEdges: debts.length,
      totalMoneyDebt: round(debts.reduce((a, l) => a + l.moneyDebt, 0), 0),
      totalFavorDebt: ledger.reduce((a, l) => a + (l.favorDebt ?? 0), 0),
      exchangesLifetime: exchanges.length,
      byKind: ['gift', 'loan', 'repay', 'favor'].reduce(
        (acc, k) => ((acc[k] = exchanges.filter((e) => e.kind === k).length), acc),
        {} as Record<string, number>,
      ),
    };

    // ---- CIVIC: town-wide decisions ----
    const resolved = issues.filter((i) => i.status === 'resolved');
    const passed = resolved.filter((i) => i.passed);
    const active = issues.find((i) => i.status === 'campaigning');
    const civic = {
      issuesLifetime: issues.length,
      resolved: resolved.length,
      passed: passed.length,
      passRate: resolved.length ? round(passed.length / resolved.length, 2) : null,
      activeIssue: active
        ? { title: active.title, topic: active.topic, resolvesDay: active.resolvesDay }
        : null,
    };

    // ---- GOSSIP: third-party reputation flow ----
    const subjectValence: Record<string, number> = {};
    for (const g of gossip) {
      subjectValence[g.subjectPlayerId as string] =
        (subjectValence[g.subjectPlayerId as string] ?? 0) + g.valence;
    }
    const gossipTier = {
      eventsLifetime: gossip.length,
      meanValence: round(mean(gossip.map((g) => g.valence)), 2), // >0 warm town, <0 cool
      subjectsNetNegative: Object.values(subjectValence).filter((v) => v < 0).length,
    };

    // ---- WORK obligation ----
    const workTier = {
      behind: work.filter((w) => w.behind).length,
      totalStandingPenalty: round(
        work.reduce((a, w) => a + (w.standingPenalty ?? 0), 0),
        0,
      ),
      totalMissed: work.reduce((a, w) => a + (w.missedCount ?? 0), 0),
    };

    // ---- GOALS ----
    const goalTier = {
      total: goals.length,
      active: goals.filter((g) => g.status === 'active').length,
      done: goals.filter((g) => g.status === 'done').length,
      missed: goals.filter((g) => g.status === 'missed').length,
      meanProgressDays: meanOf(goals, (g) => g.progressDays),
    };

    // ---- MOOD weather (the inner life, averaged) ----
    const mood = {
      meanStress: meanOf(vitals, (v) => v.stress),
      meanMomentum: meanOf(vitals, (v) => v.momentum),
      meanLeisure: meanOf(vitals, (v) => v.leisure),
      meanSocial: meanOf(vitals, (v) => v.social),
      meanEnergy: meanOf(vitals, (v) => v.energy),
      meanFood: meanOf(vitals, (v) => v.food),
      asleep: vitals.filter((v) => v.asleep).length,
    };

    return {
      worldId,
      day,
      clockFrozen: clock ? !!clock.frozen : null,
      // ⭐ the divergence dimensions, surfaced at the top for a fast read.
      divergenceIndices: {
        wealthGini: economy.wealthGini,
        reputationGini: relationshipGraph.reputationGini,
        polarizationScore: factionTier.polarizationScore,
        meanIdeaDrift: beliefLandscape.meanAbsConvictionDrift, // honest: live vs seed conviction
        beliefsDriftedFromSeed: beliefLandscape.driftedFromSeed,
      },
      economy,
      beliefLandscape,
      factionTier,
      relationshipGraph,
      reciprocity,
      civic,
      gossipTier,
      workTier,
      goalTier,
      mood,
    };
  },
});
