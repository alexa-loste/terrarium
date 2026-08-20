import { inputHandler } from './inputHandler';
import { parseGameId, playerId } from './ids';

// Terrarium v3.0 — MORTALITY.
//
// The one engine input that removes a character from the world. It exists as its own input
// rather than reusing `leave` because `leave` is unsafe for anyone with an agent attached, and
// the failure is not a bad log line — it is a permanently wedged engine. The full mechanism:
//
//   1. `leave` deletes the player from `world.players` and nothing else. In particular it never
//      touches `world.agents`; there is no `agents.delete` call anywhere in upstream AI Town.
//   2. The orphaned agent is still iterated by `Game.tick`, and `Agent.tick` began by throwing
//      `Invalid player ID` when its player was missing.
//   3. That loop runs inside `AbstractGame.runStep` OUTSIDE the try/catch that guards
//      `handleInput`, so the throw escaped before `saveStep`. Nothing committed — not the player
//      deletion, not `processedInputNumber`, not the input's return value.
//   4. `crons.restartDeadWorlds` then kicked the engine every 60s, which replayed the same
//      unconsumed input and crashed again. The character never actually died.
//
// Upstream never hit this because it only removes HUMAN players, who by construction have no
// agent record. Mortality removes agent-backed players, so it stops being unreachable.
//
// `Agent.tick` now self-heals an orphan instead of throwing, but that is a backstop for a
// partial removal — NOT the mechanism. This handler is the mechanism, and it removes both
// records in the same input so no tick ever observes the half-state.
//
// WHAT THIS DELIBERATELY DOES NOT DELETE — the character's whole footprint outlives them:
//   • `playerDescriptions` — the name has to keep resolving. Survivors' memory pipeline looks a
//     dead character's name up through it (agent/memory.ts), so deleting it breaks the LIVING.
//     Aliveness is tracked in the `lifecycle` table instead, and roster enumerators filter there.
//   • `memories` / `memoryEmbeddings` — the entire point. `memories.playerId` is a bare string
//     with no foreign key and no cascade, so a vector search on a dead character's id still
//     returns their memories. Player ids are never reused (`world.nextId` only increments), so a
//     newborn can never inherit them.
//   • relationships, goals, beliefs, vitals, gossip, ledgers — these dangle harmlessly by design.
//     Memories of the deceased still read correctly forever because the description text embeds
//     the person's NAME, not just their id.
//
// Bookkeeping that belongs to the character's death (marking `lifecycle`, recording the cause,
// writing the witness memory that seeds gossip) is NOT done here. This handler runs inside the
// engine step, which owns the world document and must stay synchronous and DB-free; the world
// doc is rewritten wholesale by `saveWorld`, so a concurrent DB write here would be clobbered.
// See `convex/lifecycle.ts` for that half.
export const lifeInputs = {
  die: inputHandler({
    args: { playerId },
    handler: (game, now, args) => {
      const pid = parseGameId('players', args.playerId);
      const player = game.world.players.get(pid);
      if (!player) {
        // Already gone — a duplicate death input, or the agent self-healed first. Idempotent on
        // purpose: throwing here would be engine-fatal for the same reason described above, and
        // "this character is not in the world" is exactly the state the caller wanted.
        return null;
      }

      // Stop any conversation first, matching `leave`. Note this also sets `toRemember` on every
      // participant INCLUDING the one dying, which would queue a remember-operation against a
      // player that is about to vanish; deleting the agent below is what prevents that firing.
      const conversation = [...game.world.conversations.values()].find((c) =>
        c.participants.has(pid),
      );
      if (conversation) {
        conversation.stop(game, now);
      }

      // Both records, same input. This is the ordering that matters: no tick may run between
      // the player deletion and the agent deletion.
      for (const agent of [...game.world.agents.values()]) {
        if (agent.playerId === pid) {
          game.world.agents.delete(agent.id);
        }
      }
      game.world.players.delete(pid);

      // `Game.saveDiff` notices both vanished and copies them into `archivedPlayers` /
      // `archivedAgents` on its own, which is what keeps the historical record intact.
      return null;
    },
  }),
};
