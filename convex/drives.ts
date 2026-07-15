import { v } from 'convex/values';
import { internalQuery, mutation, query } from './_generated/server';
import { playerId } from './aiTown/ids';
import { driveSeedFor, topDrives, driveLabel, DriveProfile } from '../data/drives';

// v2.1 — per-character drive profiles. Seeded once from data/drives.ts (keyed by display name,
// like beliefs). There's no evolution here yet — drives are the stable temperament beneath the
// shifting beliefs and moods. Stored so mood.ts and the prompt layer can read them cheaply.

export const seedWorld = mutation({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const descriptions = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    let seeded = 0;
    for (const d of descriptions) {
      const seed = driveSeedFor(d.name);
      if (!seed) continue;
      const existing = await ctx.db
        .query('driveProfiles')
        .withIndex('author', (q) => q.eq('worldId', args.worldId).eq('playerId', d.playerId))
        .first();
      if (existing) continue;
      await ctx.db.insert('driveProfiles', {
        worldId: args.worldId,
        playerId: d.playerId,
        playerName: d.name,
        profile: seed.profile,
        updatedAt: Date.now(),
      });
      seeded++;
    }
    return { seeded };
  },
});

async function loadProfile(ctx: any, worldId: string, pid: string): Promise<DriveProfile | null> {
  const row = await ctx.db
    .query('driveProfiles')
    .withIndex('author', (q: any) => q.eq('worldId', worldId).eq('playerId', pid))
    .first();
  return row?.profile ?? null;
}

// Internal: the raw profile, for mood.ts and operation gating.
export const profileFor = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: (ctx, args) => loadProfile(ctx, args.worldId, args.playerId),
});

// For prompts + UI: the loudest 2-3 drives as readable phrases.
export const topForPlayer = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const profile = await loadProfile(ctx, args.worldId, args.playerId);
    if (!profile) return [];
    return topDrives(profile, 3).map((d) => ({
      key: d.key,
      weight: d.weight,
      label: driveLabel(d.key),
    }));
  },
});

// For the UI panel: the full profile, sorted loud → quiet.
export const getForPlayer = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const profile = await loadProfile(ctx, args.worldId, args.playerId);
    if (!profile) return [];
    return topDrives(profile, 7).map((d) => ({
      key: d.key,
      weight: d.weight,
      label: driveLabel(d.key),
    }));
  },
});
