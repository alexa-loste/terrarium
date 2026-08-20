// Terrarium — PER-AGENT TRAITS (the shape, and the founding cast's seed).
//
// Several things about a character used to be looked up by DISPLAY NAME out of `Record<string, X>`
// tables in this directory: their home (data/places.ts Homes), their workplace (WorkplaceId), their
// job (data/work.ts JOBS) and their side on each charged topic (data/factions.ts TOPIC_POLE). Those
// tables only ever had entries for the 8 founding personas, so a character BORN AT RUNTIME with a
// novel name fell through every one of them — no home, no workplace, a stub job, no convictions.
//
// The fix is the same one driveProfiles already uses: a per-playerId DB row (`agentTraits`), seeded
// for the founding cast from the tables below and read from the DB thereafter. This module holds the
// pure half — the row's SHAPE, and the function that derives a founding character's row from the
// name tables. It has no DB access (it's imported by client code); convex/agentTraits.ts does the
// storage and resolution.

import { Homes, WorkplaceId, PlaceTraits } from './places';
import { JOBS, JobTraits } from './work';
import { CHARGED_TOPICS, TOPIC_POLE, PoleTraits } from './factions';

// The stored row, minus its bookkeeping columns. Every accessor that used to take just a name now
// takes an optional value of (a structural subset of) this type as a second argument.
export type AgentTraits = PlaceTraits & JobTraits & PoleTraits;

// What the name tables say about a founding character — i.e. exactly the behavior that shipped
// before agentTraits existed. This is the seed source for `seedTraitsForWorld`, and the reference
// the round-trip test asserts against.
export function traitsFromNameTables(name: string): AgentTraits {
  const home = Homes.find((h) => h.owner === name);
  const job = JOBS[name];
  const poleTable = TOPIC_POLE[name];
  const poles: Record<string, number> = {};
  for (const topic of CHARGED_TOPICS) {
    const p = poleTable?.[topic];
    if (p != null) poles[topic] = p;
  }
  return {
    homePlaceId: home?.id,
    workplaceId: WorkplaceId[name],
    // Spread rather than copy field-by-field so a Job variant's fields land as-is and the other
    // variant's stay absent (the stored validator makes them all optional).
    job: job ? { ...job } : undefined,
    poles: Object.keys(poles).length ? poles : undefined,
  };
}

// True when the name tables know nothing about this character — i.e. seeding them would produce an
// empty row. Used by the seeder to skip names it has nothing to say about.
export function hasNameTableTraits(name: string): boolean {
  const t = traitsFromNameTables(name);
  return !!(t.homePlaceId || t.workplaceId || t.job || t.poles);
}
