import { internal } from '../_generated/api';
import { fetchEmbedding } from '../util/llm';
import { composeJournalEntry, JournalTrigger } from '../aiTown/agentComms';
import { timeOfDayPrompt } from '../../data/clock';
import { GameId } from '../aiTown/ids';

// v1.7 — write one journal entry for a character and weave it back into memory.
//
// This runs from action context (the agent-operation actions). It composes a first-person
// entry via the LLM, persists it to journalEntries (the readable diary), AND inserts it into
// the vector memory store as a reflection — so the journal is a surface over memory, not a
// second brain. Best-effort: never throws into the caller (journaling shouldn't break a tick).
//
// `IMPORTANCE` is moderate: above a fleeting thought (3), below a made artifact (7).
const IMPORTANCE = 5;

export async function writeJournalEntry(
  ctx: any,
  worldId: string,
  agentId: GameId<'agents'>,
  playerId: GameId<'players'>,
  trigger: JournalTrigger,
  context?: string,
): Promise<boolean> {
  try {
    const cc = await ctx.runQuery(internal.aiTown.agentComms.commsContext, { worldId, playerId });
    if (!cc) return false;
    const time = await ctx.runQuery(internal.clock.currentTime, { worldId });

    const text = await composeJournalEntry({
      name: cc.name,
      identity: cc.identity,
      plan: cc.plan,
      memories: cc.memories,
      trigger,
      context,
      timeContext: timeOfDayPrompt(time),
    });
    if (!text) return false;

    await ctx.runMutation(internal.journal.addEntry, {
      worldId,
      playerId,
      playerName: cc.name,
      trigger,
      contextNote: context,
      text,
      day: time.day,
    });

    // Fold it back into memory so future recall + reflection can draw on it.
    const { embedding } = await fetchEmbedding(`In my journal I wrote: ${text}`);
    await ctx.runMutation(internal.agent.memory.insertMemory, {
      agentId,
      playerId,
      description: `In my journal I wrote: ${text}`,
      importance: IMPORTANCE,
      lastAccess: Date.now(),
      data: { type: 'reflection', relatedMemoryIds: [] },
      embedding,
    });

    await ctx.runMutation(internal.aiTown.agentComms.recordJournal, {
      worldId,
      playerId,
      at: Date.now(),
    });
    return true;
  } catch (e) {
    console.error('writeJournalEntry failed', e);
    return false;
  }
}
