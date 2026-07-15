import { v } from 'convex/values';
import { internal } from './_generated/api';
import { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, query } from './_generated/server';
import { playerId } from './aiTown/ids';
import { exchangeEmoji } from '../data/reciprocity';

// Terrarium v2.7 — RECIPROCITY storage + transfers. The thin Convex layer; who-helps-whom and
// how-much live in data/reciprocity.ts + agentOperations.maybeReciprocate. Every transfer moves real
// money between two agents' wallets and leaves both a log entry and a relationship ripple.

const clampMoney = (n: number) => Math.max(0, Math.round(n));

async function vitalsRow(ctx: any, worldId: Id<'worlds'>, pid: string) {
  return await ctx.db
    .query('agentVitals')
    .withIndex('playerId', (q: any) => q.eq('worldId', worldId).eq('playerId', pid))
    .first();
}

async function moveMoney(ctx: any, worldId: Id<'worlds'>, fromPid: string, toPid: string, amount: number) {
  const fromV = await vitalsRow(ctx, worldId, fromPid);
  const toV = await vitalsRow(ctx, worldId, toPid);
  if (fromV) await ctx.db.patch(fromV._id, { money: clampMoney((fromV.money ?? 0) - amount) });
  if (toV) await ctx.db.patch(toV._id, { money: clampMoney((toV.money ?? 0) + amount) });
}

async function ledgerEdge(ctx: any, worldId: Id<'worlds'>, fromPid: string, toPid: string) {
  return (
    await ctx.db
      .query('reciprocityLedger')
      .withIndex('edge', (q: any) =>
        q.eq('worldId', worldId).eq('fromPlayerId', fromPid).eq('toPlayerId', toPid),
      )
      .collect()
  )[0] as Doc<'reciprocityLedger'> | undefined;
}

async function logExchange(ctx: any, args: any, kind: string, amount: number, note?: string) {
  await ctx.db.insert('exchanges', {
    worldId: args.worldId,
    fromPlayerId: args.fromPlayerId,
    fromName: args.fromName,
    toPlayerId: args.toPlayerId,
    toName: args.toName,
    kind,
    amount,
    note: note?.slice(0, 200),
    day: args.day,
    createdAt: Date.now(),
  });
  await ctx.db.insert('townEvents', {
    worldId: args.worldId,
    ts: Date.now(),
    kind: 'relationship',
    playerName: args.fromName,
    subjectName: args.toName,
    emoji: exchangeEmoji(kind as any),
    summary:
      kind === 'gift'
        ? `${args.fromName} gave ${args.toName} ${amount} to help out.`
        : kind === 'loan'
          ? `${args.fromName} lent ${args.toName} ${amount}.`
          : kind === 'repay'
            ? `${args.fromName} paid ${args.toName} back ${amount}.`
            : `${args.fromName} did ${args.toName} a favor.`,
  });
}

const transferArgs = {
  worldId: v.id('worlds'),
  fromPlayerId: playerId,
  fromName: v.string(),
  toPlayerId: playerId,
  toName: v.string(),
  amount: v.number(),
  note: v.optional(v.string()),
  day: v.number(),
};

// GIFT — money given outright. Recipient warms to the giver (gratitude); the giver feels closer too.
export const giveGift = internalMutation({
  args: transferArgs,
  handler: async (ctx, args) => {
    if (args.amount <= 0) return;
    await moveMoney(ctx, args.worldId, args.fromPlayerId, args.toPlayerId, args.amount);
    await ctx.runMutation(internal.relationships.nudgeDirected, {
      worldId: args.worldId,
      fromPlayerId: args.toPlayerId, // recipient → giver: gratitude
      fromName: args.toName,
      toPlayerId: args.fromPlayerId,
      toName: args.fromName,
      warmth: 2,
      respect: 1,
    });
    await ctx.runMutation(internal.relationships.nudgeDirected, {
      worldId: args.worldId,
      fromPlayerId: args.fromPlayerId, // giver → recipient: you warm to those you help
      fromName: args.fromName,
      toPlayerId: args.toPlayerId,
      toName: args.toName,
      warmth: 1,
      respect: 0,
    });
    await logExchange(ctx, args, 'gift', args.amount, args.note);
  },
});

// LOAN — money lent; the recipient now owes it back. The lender extends a little trust.
export const lend = internalMutation({
  args: transferArgs,
  handler: async (ctx, args) => {
    if (args.amount <= 0) return;
    await moveMoney(ctx, args.worldId, args.fromPlayerId, args.toPlayerId, args.amount);
    // Ledger: borrower (to) now owes lender (from).
    const edge = await ledgerEdge(ctx, args.worldId, args.toPlayerId, args.fromPlayerId);
    const now = Date.now();
    if (edge) {
      await ctx.db.patch(edge._id, {
        moneyDebt: edge.moneyDebt + args.amount,
        debtSinceDay: edge.moneyDebt <= 0 ? args.day : edge.debtSinceDay ?? args.day,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('reciprocityLedger', {
        worldId: args.worldId,
        fromPlayerId: args.toPlayerId,
        toPlayerId: args.fromPlayerId,
        moneyDebt: args.amount,
        favorDebt: 0,
        debtSinceDay: args.day,
        updatedAt: now,
      });
    }
    await ctx.runMutation(internal.relationships.nudgeDirected, {
      worldId: args.worldId,
      fromPlayerId: args.fromPlayerId,
      fromName: args.fromName,
      toPlayerId: args.toPlayerId,
      toName: args.toName,
      warmth: 1,
      respect: 0,
    });
    await logExchange(ctx, args, 'loan', args.amount, args.note);
  },
});

// REPAY — pay back what you owe (from = the debtor paying to = the creditor). Reliability builds trust.
export const repay = internalMutation({
  args: transferArgs,
  handler: async (ctx, args) => {
    if (args.amount <= 0) return;
    const edge = await ledgerEdge(ctx, args.worldId, args.fromPlayerId, args.toPlayerId);
    if (!edge || edge.moneyDebt <= 0) return;
    const pay = Math.min(args.amount, edge.moneyDebt);
    await moveMoney(ctx, args.worldId, args.fromPlayerId, args.toPlayerId, pay);
    const remaining = edge.moneyDebt - pay;
    await ctx.db.patch(edge._id, {
      moneyDebt: Math.max(0, remaining),
      debtSinceDay: remaining <= 0 ? undefined : edge.debtSinceDay,
      updatedAt: Date.now(),
    });
    await ctx.runMutation(internal.relationships.nudgeDirected, {
      worldId: args.worldId,
      fromPlayerId: args.toPlayerId, // creditor → debtor: they came through
      fromName: args.toName,
      toPlayerId: args.fromPlayerId,
      toName: args.fromName,
      warmth: 1,
      respect: 2,
    });
    await logExchange(ctx, { ...args, amount: pay }, 'repay', pay, args.note);
  },
});

// FAVOR — a non-money kindness; a soft obligation to return it (favorDebt), plus warmth.
export const doFavor = internalMutation({
  args: transferArgs,
  handler: async (ctx, args) => {
    const edge = await ledgerEdge(ctx, args.worldId, args.toPlayerId, args.fromPlayerId);
    const now = Date.now();
    if (edge) await ctx.db.patch(edge._id, { favorDebt: edge.favorDebt + 1, updatedAt: now });
    else
      await ctx.db.insert('reciprocityLedger', {
        worldId: args.worldId,
        fromPlayerId: args.toPlayerId,
        toPlayerId: args.fromPlayerId,
        moneyDebt: 0,
        favorDebt: 1,
        updatedAt: now,
      });
    await ctx.runMutation(internal.relationships.nudgeDirected, {
      worldId: args.worldId,
      fromPlayerId: args.toPlayerId,
      fromName: args.toName,
      toPlayerId: args.fromPlayerId,
      toName: args.fromName,
      warmth: 2,
      respect: 0,
    });
    await logExchange(ctx, { ...args, amount: 0 }, 'favor', 0, args.note);
  },
});

// Nightly (creditor side): a money-debt that's gone unpaid for a while quietly sours the lender on
// the borrower — resentment. Repaying clears the debt and stops the erosion.
export const agedDebtResentment = internalMutation({
  args: { worldId: v.id('worlds'), creditorPlayerId: playerId, creditorName: v.string(), currentDay: v.number() },
  handler: async (ctx, args) => {
    const debts = (await ctx.db
      .query('reciprocityLedger')
      .withIndex('creditor', (q: any) =>
        q.eq('worldId', args.worldId).eq('toPlayerId', args.creditorPlayerId),
      )
      .collect()) as Doc<'reciprocityLedger'>[];
    for (const d of debts) {
      if (d.moneyDebt <= 0) continue;
      const age = args.currentDay - (d.debtSinceDay ?? args.currentDay);
      if (age < 3) continue; // a few days' grace
      const debtorDesc = await ctx.db
        .query('playerDescriptions')
        .withIndex('worldId', (q: any) =>
          q.eq('worldId', args.worldId).eq('playerId', d.fromPlayerId),
        )
        .first();
      await ctx.runMutation(internal.relationships.nudgeDirected, {
        worldId: args.worldId,
        fromPlayerId: args.creditorPlayerId,
        fromName: args.creditorName,
        toPlayerId: d.fromPlayerId,
        toName: debtorDesc?.name ?? 'them',
        warmth: -1,
        respect: -1,
      });
    }
  },
});

// ── reads ────────────────────────────────────────────────────────────────────────────────────────

// Shared ledger computation (plain helper so both the internalQuery and the public query can use it
// — Convex queries can't call ctx.runQuery).
async function computeLedger(ctx: any, worldId: Id<'worlds'>, pid: string) {
  const oweRows = (await ctx.db
    .query('reciprocityLedger')
    .withIndex('debtor', (q: any) => q.eq('worldId', worldId).eq('fromPlayerId', pid))
    .collect()) as Doc<'reciprocityLedger'>[];
  const owedRows = (await ctx.db
    .query('reciprocityLedger')
    .withIndex('creditor', (q: any) => q.eq('worldId', worldId).eq('toPlayerId', pid))
    .collect()) as Doc<'reciprocityLedger'>[];
  const nameOf = async (p: string) =>
    (
      await ctx.db
        .query('playerDescriptions')
        .withIndex('worldId', (q: any) => q.eq('worldId', worldId).eq('playerId', p))
        .first()
    )?.name ?? 'someone';
  const owe = [];
  for (const r of oweRows)
    if (r.moneyDebt > 0)
      owe.push({
        playerId: String(r.toPlayerId),
        name: await nameOf(String(r.toPlayerId)),
        amount: Math.round(r.moneyDebt),
      });
  const owed = [];
  for (const r of owedRows)
    if (r.moneyDebt > 0)
      owed.push({
        playerId: String(r.fromPlayerId),
        name: await nameOf(String(r.fromPlayerId)),
        amount: Math.round(r.moneyDebt),
      });
  return { owe: owe.sort((a, b) => b.amount - a.amount), owed: owed.sort((a, b) => b.amount - a.amount) };
}

// For prompts: what this character owes others, and what others owe them (money, top few).
export const ledgerForPlayer = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => computeLedger(ctx, args.worldId, String(args.playerId)),
});

// For mood: total money this character currently owes (drives a little background stress).
export const totalOwedBy = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const rows = (await ctx.db
      .query('reciprocityLedger')
      .withIndex('debtor', (q: any) => q.eq('worldId', args.worldId).eq('fromPlayerId', args.playerId))
      .collect()) as Doc<'reciprocityLedger'>[];
    return rows.reduce((s, r) => s + Math.max(0, r.moneyDebt), 0);
  },
});

// UI: this character's debts/credits + recent exchanges they were part of.
export const forPlayer = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const ledger = await computeLedger(ctx, args.worldId, String(args.playerId));
    const sent = (await ctx.db
      .query('exchanges')
      .withIndex('from', (q: any) => q.eq('worldId', args.worldId).eq('fromPlayerId', args.playerId))
      .collect()) as Doc<'exchanges'>[];
    const got = (await ctx.db
      .query('exchanges')
      .withIndex('to', (q: any) => q.eq('worldId', args.worldId).eq('toPlayerId', args.playerId))
      .collect()) as Doc<'exchanges'>[];
    const recent = [...sent, ...got]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 8)
      .map((e) => ({
        id: e._id,
        fromName: e.fromName,
        toName: e.toName,
        kind: e.kind,
        amount: e.amount,
        day: e.day,
      }));
    return { ...ledger, recent };
  },
});
