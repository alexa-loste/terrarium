import { describe, expect, test } from '@jest/globals';
import { traitsFromNameTables } from './traits';
import { Descriptions } from './characters';
import { homeFor, workFor } from './places';
import { isScheduled, jobFor, jobLabel, withinShift, gatheringHourFor } from './work';
import { CHARGED_TOPICS, priorPole } from './factions';

// The founding cast must be BYTE-IDENTICAL after the agentTraits refactor: resolving a seeded row
// has to give the same answer the name table gave. Every accessor that gained a `traits` argument
// is exercised both ways here, so a drift in the seed derivation goes red rather than quietly
// re-homing someone.

const FOUNDING = Descriptions.map((d) => d.name);

describe('agentTraits seed round-trip', () => {
  test('the founding cast is the 8 named personas', () => {
    expect(FOUNDING).toEqual(['Mara', 'Priya', 'Theo', 'Gloria', 'Naomi', 'Desmond', 'Yuki', 'Russ']);
  });

  for (const name of FOUNDING) {
    describe(name, () => {
      const traits = traitsFromNameTables(name);

      test('home', () => {
        expect(homeFor(name, traits)).toEqual(homeFor(name));
        expect(homeFor(name, traits)).toBeDefined();
      });

      test('workplace', () => {
        expect(workFor(name, traits)).toEqual(workFor(name));
        expect(workFor(name, traits)).toBeDefined();
      });

      test('job', () => {
        expect(jobFor(name, traits)).toEqual(jobFor(name));
        expect(isScheduled(name, traits)).toBe(isScheduled(name));
        expect(jobLabel(name, traits)).toBe(jobLabel(name));
      });

      test('shift hours', () => {
        for (let hour = 0; hour < 24; hour++) {
          expect(withinShift(name, hour, traits)).toBe(withinShift(name, hour));
        }
      });

      test('gathering hour', () => {
        for (const pick of [0, 0.25, 0.5, 0.75, 1]) {
          expect(gatheringHourFor(name, pick, traits)).toBe(gatheringHourFor(name, pick));
        }
      });

      test('poles on every charged topic', () => {
        for (const topic of CHARGED_TOPICS) {
          expect(priorPole(name, topic, traits)).toBe(priorPole(name, topic));
        }
        // ...and a topic nobody has a side on stays null either way.
        expect(priorPole(name, 'housing', traits)).toBeNull();
        expect(priorPole(name, 'housing')).toBeNull();
      });
    });
  }
});

describe('a character the name tables have never heard of', () => {
  const NOVEL = 'Wren';

  test('falls through every name table with no row', () => {
    expect(homeFor(NOVEL)).toBeUndefined();
    expect(workFor(NOVEL)).toBeUndefined();
    expect(jobFor(NOVEL)).toEqual({ kind: 'deliverable', quota: 1, perDays: 2 });
    expect(priorPole(NOVEL, 'regulation')).toBeNull();
  });

  test('resolves from a row when one exists', () => {
    const traits = {
      homePlaceId: 'home-yuki',
      workplaceId: 'lab',
      job: { kind: 'scheduled' as const, startHour: 7, endHour: 15 },
      poles: { regulation: -1, automation: 1 },
    };
    expect(homeFor(NOVEL, traits)?.id).toBe('home-yuki');
    expect(workFor(NOVEL, traits)?.id).toBe('lab');
    expect(jobFor(NOVEL, traits)).toEqual({ kind: 'scheduled', startHour: 7, endHour: 15 });
    expect(isScheduled(NOVEL, traits)).toBe(true);
    expect(withinShift(NOVEL, 7, traits)).toBe(true);
    expect(withinShift(NOVEL, 15, traits)).toBe(false);
    expect(priorPole(NOVEL, 'regulation', traits)).toBe(-1);
    expect(priorPole(NOVEL, 'automation', traits)).toBe(1);
    expect(priorPole(NOVEL, 'AI safety', traits)).toBeNull();
  });

  test('a row is authoritative — it never falls back to the name table', () => {
    // Mara has a home, a workplace, a deliverable job and three poles in the name tables. An empty
    // row means she has none of them, not "go look Mara up".
    const empty = {};
    expect(homeFor('Mara', empty)).toBeUndefined();
    expect(workFor('Mara', empty)).toBeUndefined();
    expect(jobFor('Mara', empty)).toEqual({ kind: 'deliverable', quota: 1, perDays: 2 });
    expect(priorPole('Mara', 'regulation', empty)).toBeNull();
  });
});
