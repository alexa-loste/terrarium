// Terrarium v2.7 — RECIPROCITY & EXCHANGE (the horizontal economy).
//
// Until now money flowed only person↔WORLD (wage in, food out). The most foundational social-economic
// primitive was missing: value moving person↔PERSON. Reciprocity and obligation are older glue than
// money itself — "I'll get you next time," a gift that builds warmth, a loan that becomes a debt that
// becomes resentment if it lingers. This adds that horizontal layer:
//
//   • GIFT  — give money to someone you care about who's struggling, expecting nothing. Builds warmth
//             + your standing as generous; the rich quietly carrying the precarious is realistic.
//   • LOAN  — lend to a pinched friend; they now OWE you. Trust extended.
//   • REPAY — pay back what you owe; reliability builds trust. Leaving it unpaid frays the bond.
//   • FAVOR — a non-money kindness; a soft obligation to return it.
//
// Design intent (alexa, throughout): emergent + non-coercive. You only help people you actually feel
// warm toward, only when you have a real surplus and they're in real need; you repay because the debt
// nags. Nobody is forced to be generous — it falls out of who's close to whom + who has slack.
//
// Wired in: convex/schema.ts (exchanges + reciprocityLedger), convex/reciprocity.ts (the transfers +
// debt-strain), agentComms (composeReciprocityNote), agentOperations (maybeReciprocate + nightly
// debtStrain), conversation.ts (what you owe / are owed colors talk), PlayerDetails (🤝 Favors & debts).

import { DriveProfile } from './drives';

export type ExchangeKind = 'gift' | 'loan' | 'repay' | 'favor';

export const RECIPROCATE_CHANCE = 0.1;
export const RECIPROCATE_COOLDOWN_MS = 1000 * 60 * 8;

// Buffer-days (money / cost-of-living) thresholds — reuse the economy's precarity lens.
export const NEED_BUFFER_DAYS = 10; // below this, someone's visibly struggling
export const SURPLUS_BUFFER_DAYS = 22; // above this, you have real slack to give
export const GIFT_AFFINITY = 70; // this close → you'd just give; below (but warm) → you'd lend
export const HELP_MIN_AFFINITY = 55; // you only help people you're genuinely warm with

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const w = (p: DriveProfile, k: keyof DriveProfile) => p[k] ?? 40;

// How giving this character is, 0..1 — care for others (connection + principle) net of self-protective
// hoarding (security). Generous people help sooner and bigger.
export function generosityFor(profile: DriveProfile): number {
  const care = (w(profile, 'connection') + w(profile, 'principle')) / 2;
  const hoard = w(profile, 'security');
  return clamp(0.25 + (care - hoard * 0.45) / 100, 0.1, 1);
}

export function bufferDays(money: number, costOfLiving: number): number {
  return money / Math.max(1, costOfLiving);
}
export function inNeed(money: number, costOfLiving: number): boolean {
  return bufferDays(money, costOfLiving) < NEED_BUFFER_DAYS;
}
export function hasSurplus(money: number, costOfLiving: number): boolean {
  return bufferDays(money, costOfLiving) > SURPLUS_BUFFER_DAYS;
}

// How much to give/lend: a slice of the giver's surplus (above their own comfortable buffer), capped
// to something meaningful for the recipient (a few of THEIR cost-of-living days) and to whole units.
export function helpAmount(
  giverMoney: number,
  giverCOL: number,
  targetCOL: number,
  generosity: number,
): number {
  const surplus = Math.max(0, giverMoney - SURPLUS_BUFFER_DAYS * giverCOL);
  if (surplus < targetCOL) return 0; // not enough slack to meaningfully help
  const fromSurplus = surplus * (0.18 + generosity * 0.22); // 18–40% of slack
  const meaningfulCap = targetCOL * 6; // ~6 days of their living costs, tops
  return Math.round(Math.min(fromSurplus, meaningfulCap));
}

// Gift outright (very close) vs lend (warm but not as close, or you're more security-minded).
export function shouldGift(affinity: number, generosity: number): boolean {
  return affinity >= GIFT_AFFINITY || generosity > 0.7;
}

// A repayment amount: clear the debt if you can comfortably afford it, else a partial good-faith chunk.
export function repayAmount(debt: number, payerMoney: number, payerCOL: number): number {
  const keepBuffer = NEED_BUFFER_DAYS * payerCOL; // don't repay yourself into hardship
  const spare = Math.max(0, payerMoney - keepBuffer);
  if (spare <= 0) return 0;
  return Math.round(Math.min(debt, spare));
}

// A lingering money-debt sits on the debtor's mind — small stress that scales with the debt relative
// to their living costs, weighted by how security-minded they are. Repaying clears it.
export function debtStress(debt: number, costOfLiving: number, securityWeight: number): number {
  if (debt <= 0) return 0;
  const daysOwed = debt / Math.max(1, costOfLiving);
  return clamp((daysOwed / 12) * 14 * securityWeight, 0, 16);
}

export function exchangeEmoji(kind: ExchangeKind): string {
  return kind === 'gift' ? '🎁' : kind === 'loan' ? '🪙' : kind === 'repay' ? '↩️' : '🤲';
}
