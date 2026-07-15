import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { playerId } from './aiTown/ids';
import {
  leisureIntoleranceFor,
  recognitionSensitivityFor,
  securityWeightFor,
  DriveProfile,
} from '../data/drives';
import { MAX_FOOD, STARTING_MONEY, costOfLivingFor, moneyStress } from '../data/economy';
import { debtStress } from '../data/reciprocity';
import { START_LEISURE, START_SOCIAL } from './agentVitals';

// v2.1 — MOOD derivation. Stress + momentum are NOT bars you fill; they're weather rolled up
// from durable state, weighted by the character's drives. Recomputed during the nightly pass
// (and after gatherings/goal events), then read cheaply by the dialogue layer so the inner state
// actually shows up in how they talk. SOFT inter-agent coupling lives here: a character's
// relative STANDING (how others feel about them, vs the rest of the cast) feeds stress/momentum
// in proportion to how recognition-driven they are — so someone else's rising influence is felt
// as pressure by the people who care about being seen, without any scripted conflict.

const clamp = (n: number) => Math.max(0, Math.min(100, n));

// This player's standing as a 0..1 position within the cast (0 = lowest regarded, 1 = highest).
// Mirrors listReputation: inbound affinity+respect above neutral, minus work standing penalty.
async function standingNorm(ctx: any, worldId: string, pid: string): Promise<number | null> {
  const edges = await ctx.db
    .query('relationships')
    .withIndex('inbound', (q: any) => q.eq('worldId', worldId))
    .collect();
  if (!edges.length) return null;
  const score = new Map<string, number>();
  for (const e of edges) {
    score.set(e.toPlayerId, (score.get(e.toPlayerId) ?? 0) + (e.affinity - 50) + (e.respect - 50));
  }
  const work = await ctx.db
    .query('workState')
    .withIndex('author', (q: any) => q.eq('worldId', worldId))
    .collect();
  for (const wk of work) {
    if (wk.standingPenalty)
      score.set(wk.playerId, (score.get(wk.playerId) ?? 0) - wk.standingPenalty);
  }
  const vals = [...score.values()];
  const mine = score.get(pid);
  if (mine === undefined || vals.length < 2) return null;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  if (hi === lo) return 0.5;
  return (mine - lo) / (hi - lo);
}

// Recompute one character's stress + momentum from the world as it stands. Returns the new
// values + a short human reason for the dominant stressor (for journaling / the prompt).
export const recompute = internalMutation({
  args: { worldId: v.id('worlds'), playerId, currentDay: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{ stress: number; momentum: number; reason: string | null }> => {
    const vitals = await ctx.db
      .query('agentVitals')
      .withIndex('playerId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    if (!vitals) return { stress: 25, momentum: 50, reason: null };

    const desc = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    const name = desc?.name ?? '';

    const driveRow = await ctx.db
      .query('driveProfiles')
      .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    const profile: DriveProfile = driveRow?.profile ?? {};

    const goals = await ctx.db
      .query('goals')
      .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .collect();
    const recentDone = goals.filter(
      (g) => g.status === 'done' && (g.resolvedDay ?? -99) >= args.currentDay - 2,
    ).length;
    const recentMissed = goals.filter(
      (g) => g.status === 'missed' && (g.resolvedDay ?? -99) >= args.currentDay - 2,
    ).length;
    const overdueSoon = goals.filter(
      (g) => g.tier === 'short' && g.status === 'active' && args.currentDay >= g.dueDay,
    ).length;

    const work = await ctx.db
      .query('workState')
      .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    const behind = !!work?.behind;

    const food = vitals.food ?? MAX_FOOD;
    const money = vitals.money ?? STARTING_MONEY;
    const social = vitals.social ?? START_SOCIAL;
    const leisure = vitals.leisure ?? START_LEISURE;

    const standing = await standingNorm(ctx, args.worldId, args.playerId);

    // --- STRESS ---
    const reasons: { amount: number; text: string }[] = [];
    let stress = 10; // a little baseline tension is normal
    const foodS = ((100 - food) / 100) * 8;
    if (foodS > 4) reasons.push({ amount: foodS, text: 'running on empty' });
    // v2.5 — money-stress as a thin-BUFFER signal relative to this persona's cost of living, not an
    // absolute floor: the precarious feel it even with a few hundred saved; the comfortable don't.
    const moneyDeficit = moneyStress(money, costOfLivingFor(name), securityWeightFor(profile));
    if (moneyDeficit > 5) reasons.push({ amount: moneyDeficit, text: 'money is tight' });
    // v2.7 — money you owe others sits on your mind too (scaled by how security-minded you are).
    const debtRows = await ctx.db
      .query('reciprocityLedger')
      .withIndex('debtor', (q) => q.eq('worldId', args.worldId).eq('fromPlayerId', args.playerId))
      .collect();
    const owed = debtRows.reduce((s, r) => s + Math.max(0, r.moneyDebt), 0);
    const debtS = debtStress(owed, costOfLivingFor(name), securityWeightFor(profile));
    if (debtS > 4) reasons.push({ amount: debtS, text: `you still owe money` });
    const leisureS = ((100 - leisure) / 100) * 20 * leisureIntoleranceFor(profile);
    if (leisureS > 6)
      reasons.push({ amount: leisureS, text: "you haven't had a moment to yourself" });
    const socialS = ((100 - social) / 100) * 10;
    if (socialS > 5) reasons.push({ amount: socialS, text: 'you feel disconnected lately' });
    const behindS = behind ? 18 : 0;
    if (behindS) reasons.push({ amount: behindS, text: "you're behind on your work" });
    const goalS = overdueSoon * 10 + recentMissed * 12;
    if (goalS > 6) reasons.push({ amount: goalS, text: 'a deadline you set yourself is slipping' });
    let standingS = 0;
    if (standing !== null) {
      standingS = recognitionSensitivityFor(profile) * Math.max(0, 0.5 - standing) * 34;
      if (standingS > 6)
        reasons.push({
          amount: standingS,
          text: 'others seem to be getting noticed more than you',
        });
    }
    stress = clamp(
      stress + foodS + moneyDeficit + debtS + leisureS + socialS + behindS + goalS + standingS,
    );

    // --- MOMENTUM ---
    let momentum = 50;
    momentum += recentDone * 10 - recentMissed * 10;
    momentum += behind ? -12 : 3;
    if (standing !== null) momentum += recognitionSensitivityFor(profile) * (standing - 0.5) * 26;
    if (leisure > 55) momentum += 3;
    else if (leisure < 20) momentum -= 5;
    momentum = clamp(momentum);

    await ctx.db.patch(vitals._id, { stress, momentum });

    const reason = reasons.sort((a, b) => b.amount - a.amount)[0]?.text ?? null;
    return { stress, momentum, reason };
  },
});
