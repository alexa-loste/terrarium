import { cronJobs } from 'convex/server';
import { DELETE_BATCH_SIZE, IDLE_WORLD_TIMEOUT, VACUUM_MAX_AGE } from './constants';
import { internal } from './_generated/api';
import { internalMutation } from './_generated/server';
import { TableNames } from './_generated/dataModel';
import { v } from 'convex/values';

const crons = cronJobs();

crons.interval(
  'stop inactive worlds',
  { seconds: IDLE_WORLD_TIMEOUT / 1000 },
  internal.world.stopInactiveWorlds,
);

crons.interval('restart dead worlds', { seconds: 60 }, internal.world.restartDeadWorlds);

crons.daily('vacuum old entries', { hourUTC: 4, minuteUTC: 20 }, internal.crons.vacuumOldEntries);

export default crons;

const TablesToVacuum: TableNames[] = [
  // Un-comment this to also clean out old conversations.
  // 'conversationMembers', 'conversations', 'messages',

  // Inputs aren't useful unless you're trying to replay history.
  // If you want to support that, you should add a snapshot table, so you can
  // replay from a certain time period. Or stop vacuuming inputs and replay from
  // the beginning of time
  'inputs',

  // ⛔ 'memories' and 'memoryEmbeddings' were HERE and have been removed deliberately.
  //
  // Two reasons, and the second one applies whether or not mortality ever ships.
  //
  // (1) Memory has to outlive the agent. Death keeps a character's memories in the vector
  //     store so survivors can still recall the dead. A daily sweep deleting anything older
  //     than VACUUM_MAX_AGE (2 weeks) made that promise false on a two-week timer — and it was
  //     already quietly capping every LIVING agent's long-term memory at a fortnight, which is
  //     almost certainly not what anyone intended.
  //
  // (2) The pair is not vacuumed atomically. These are two independent table sweeps, each
  //     batch-limited. Delete a `memories` row while its `memoryEmbeddings` row survives and
  //     the next vector search for that player hits
  //     `throw new Error('Memory for embedding ... not found')` in rankAndTouchMemories
  //     (convex/agent/memory.ts) — one half-swept pair poisons every subsequent search for
  //     that character. That hazard predates this change.
  //
  // COST, stated plainly: vectors now grow without bound. The upstream comment warned that
  // >>100k vectors degrade search, and nothing here replaces that pressure valve. The right
  // fix when it starts to bite is importance-based pruning (drop low-importance memories,
  // keep reflections and high-importance ones) deleting BOTH rows together — not an age
  // sweep, which throws away exactly the old memories that make a long-lived town interesting.

  // v2.8 — append-only DISPLAY logs that grow unbounded and nothing reads past ~2 weeks (the
  // chronicle, the gossip ticker, the feed). Their downstream effects (relationship nudges,
  // reactions) all fire at write time, so trimming old rows is purely a storage win.
  'townEvents',
  'gossipEvents',
  'feedPosts',
];

export const vacuumOldEntries = internalMutation({
  args: {},
  handler: async (ctx, args) => {
    const before = Date.now() - VACUUM_MAX_AGE;
    for (const tableName of TablesToVacuum) {
      console.log(`Checking ${tableName}...`);
      const exists = await ctx.db
        .query(tableName)
        .withIndex('by_creation_time', (q) => q.lt('_creationTime', before))
        .first();
      if (exists) {
        console.log(`Vacuuming ${tableName}...`);
        await ctx.scheduler.runAfter(0, internal.crons.vacuumTable, {
          tableName,
          before,
          cursor: null,
          soFar: 0,
        });
      }
    }
  },
});

export const vacuumTable = internalMutation({
  args: {
    tableName: v.string(),
    before: v.number(),
    cursor: v.union(v.string(), v.null()),
    soFar: v.number(),
  },
  handler: async (ctx, { tableName, before, cursor, soFar }) => {
    const results = await ctx.db
      .query(tableName as TableNames)
      .withIndex('by_creation_time', (q) => q.lt('_creationTime', before))
      .paginate({ cursor, numItems: DELETE_BATCH_SIZE });
    for (const row of results.page) {
      await ctx.db.delete(row._id);
    }
    if (!results.isDone) {
      await ctx.scheduler.runAfter(0, internal.crons.vacuumTable, {
        tableName,
        before,
        soFar: results.page.length + soFar,
        cursor: results.continueCursor,
      });
    } else {
      console.log(`Vacuumed ${soFar + results.page.length} entries from ${tableName}`);
    }
  },
});
