import { v } from 'convex/values';
import { internalQuery, mutation, query, QueryCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import { playerId } from './aiTown/ids';
import { AgentTraits, hasNameTableTraits, traitsFromNameTables } from '../data/traits';

// Per-agent traits — home, workplace, job, and side on each charged topic. Seeded once for the
// founding cast from the name-keyed tables in data/ (exactly like convex/drives.ts does for
// driveProfiles), and thereafter the source of truth, so a character born at runtime with a novel
// name resolves to a real home/job/conviction instead of falling through every table.
//
// The contract, and the reason the founding 8 are unchanged by this: a row, when it exists, is
// AUTHORITATIVE — the data/ accessors take it as an optional second argument and consult the name
// table only when no row is passed. Seeding writes precisely what the name table says, so
// `getTraits` for each of the 8 returns what the name table returned before. data/traits.test.ts
// asserts that round trip.

export type { AgentTraits };

// Seed rows for every character in the world that the name tables know about. Idempotent: an
// existing row is left alone (it may have drifted or been inherited at birth).
export const seedTraitsForWorld = mutation({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const descriptions = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    let seeded = 0;
    for (const d of descriptions) {
      if (!hasNameTableTraits(d.name)) continue;
      const existing = await ctx.db
        .query('agentTraits')
        .withIndex('playerId', (q) => q.eq('worldId', args.worldId).eq('playerId', d.playerId))
        .first();
      if (existing) continue;
      const seed = compact(traitsFromNameTables(d.name));
      await ctx.db.insert('agentTraits', {
        worldId: args.worldId,
        playerId: d.playerId,
        playerName: d.name,
        ...seed,
        updatedAt: Date.now(),
      });
      seeded++;
    }
    return { seeded };
  },
});

// ── resolution ──────────────────────────────────────────────────────────────────────────────────

// Drop absent fields rather than carrying `undefined` keys across the Convex boundary (into a
// db.insert or out of a query) — an absent trait and an explicitly-undefined one mean the same
// thing here, and only one of them is a Convex value.
type StoredTraits = {
  homePlaceId?: string;
  workplaceId?: string;
  job?: NonNullable<AgentTraits['job']>;
  poles?: NonNullable<AgentTraits['poles']>;
};

function compact(t: AgentTraits): StoredTraits {
  const out: StoredTraits = {};
  if (t.homePlaceId !== undefined) out.homePlaceId = t.homePlaceId;
  if (t.workplaceId !== undefined) out.workplaceId = t.workplaceId;
  if (t.job != null) out.job = t.job;
  if (t.poles != null) out.poles = t.poles;
  return out;
}

function rowToTraits(row: Doc<'agentTraits'>): AgentTraits {
  return compact({
    homePlaceId: row.homePlaceId,
    workplaceId: row.workplaceId,
    job: row.job,
    poles: row.poles,
  });
}

// The one resolver. Returns null when there's no row, which every data/ accessor reads as "fall
// back to the name table" — so an un-seeded world behaves exactly as it did before this table.
export async function getTraits(
  ctx: QueryCtx,
  worldId: Id<'worlds'>,
  pid: string,
): Promise<AgentTraits | null> {
  const row = await ctx.db
    .query('agentTraits')
    .withIndex('playerId', (q) => q.eq('worldId', worldId).eq('playerId', pid))
    .first();
  return row ? rowToTraits(row) : null;
}

// Bulk form for the whole-cast loops (relationships/civics seeding, faction nightly recompute):
// one scan instead of one query per player. Keyed by playerId as a string.
export async function getTraitsByPlayer(
  ctx: QueryCtx,
  worldId: Id<'worlds'>,
): Promise<Map<string, AgentTraits>> {
  const rows = await ctx.db
    .query('agentTraits')
    .withIndex('playerId', (q) => q.eq('worldId', worldId))
    .collect();
  const map = new Map<string, AgentTraits>();
  for (const row of rows) map.set(String(row.playerId), rowToTraits(row));
  return map;
}

// For actions (agentOperations), which have no ctx.db.
export const traitsFor = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: (ctx, args) => getTraits(ctx, args.worldId, args.playerId),
});

// For actions that need the whole cast's poles at once (maybeFormFaction weighs everyone else's
// side). A plain object rather than a Map so it survives the action boundary.
export const traitsForWorld = internalQuery({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args): Promise<Record<string, AgentTraits>> => {
    const map = await getTraitsByPlayer(ctx, args.worldId);
    return Object.fromEntries(map);
  },
});

// For the UI (PlayerDetails' job line).
export const getForPlayer = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: (ctx, args) => getTraits(ctx, args.worldId, args.playerId),
});

// Key-order-independent serialization — a stored object's key order is not guaranteed to match the
// literal it was seeded from, and that difference is not a behavior difference.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

// A live check that seeding didn't change anyone's behavior: for every stored row whose name the
// name tables still know, the row must equal what the name table says. Returns the mismatches (an
// empty list is the pass). Run with:
//   npx convex run agentTraits:verifySeed '{"worldId":"..."}'
export const verifySeed = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('agentTraits')
      .withIndex('playerId', (q) => q.eq('worldId', args.worldId))
      .collect();
    const mismatches: { playerName: string; stored: AgentTraits; nameTable: AgentTraits }[] = [];
    for (const row of rows) {
      if (!hasNameTableTraits(row.playerName)) continue; // born at runtime — nothing to compare to
      const stored = rowToTraits(row);
      const nameTable = traitsFromNameTables(row.playerName);
      if (canonical(stored) !== canonical(nameTable)) {
        mismatches.push({ playerName: row.playerName, stored, nameTable });
      }
    }
    return { checked: rows.length, mismatches };
  },
});
