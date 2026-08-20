import { describe, expect, test } from '@jest/globals';
import { Descriptions } from './characters';
import {
  ELDER_WINDOW,
  FOUNDING_AGES,
  LIFESPAN_MAX,
  LIFESPAN_MEAN,
  LIFESPAN_MIN,
  MATURITY_AGE,
  PEAK_HAZARD,
  ageOn,
  bornDayForAge,
  deathHazard,
  drawLifespan,
  seedLifespanFor,
  stageFor,
  stageNote,
} from './lifecycle';

// ── The drift guard ─────────────────────────────────────────────────────────────────────────────
//
// FOUNDING_AGES duplicates a number that also lives in the identity prose, and the prose is the
// one the model actually reads. So the test re-derives the table from the sentences: edit a bio to
// make Theo 34 and this goes red, instead of the town quietly disagreeing with itself about how
// old someone is.

// "I'm Theo, 29, an illustrator and musician who…" — the shape every founding bio opens with.
function ageFromIdentity(identity: string): number | null {
  const m = identity.match(/I'm\s+([A-Z][a-z]+),\s*(\d+)\b/);
  return m ? Number(m[2]) : null;
}

describe('founding ages match the identity prose', () => {
  test('every founder states an age in their bio', () => {
    // Guards the regex itself: if the prose style changes, this fails LOUDLY rather than making
    // every per-character check below vacuously pass on a null it never compared.
    for (const d of Descriptions) {
      expect([d.name, ageFromIdentity(d.identity)]).not.toEqual([d.name, null]);
    }
  });

  test('the table covers exactly the founding cast', () => {
    expect(Object.keys(FOUNDING_AGES).sort()).toEqual(Descriptions.map((d) => d.name).sort());
  });

  for (const d of Descriptions) {
    test(`${d.name}`, () => {
      expect(FOUNDING_AGES[d.name]).toBe(ageFromIdentity(d.identity));
    });
  }
});

// ── Age is derived, not accumulated ─────────────────────────────────────────────────────────────

describe('age', () => {
  test('a founder is the age their bio claims, on whatever day the seed runs', () => {
    // The bug this exists to catch: seeding a world already 40 days old by treating bornDay as
    // day 1, which would make Mara 71.
    for (const seedDay of [1, 7, 40, 365]) {
      for (const [name, age] of Object.entries(FOUNDING_AGES)) {
        const bornDay = bornDayForAge(seedDay, age);
        expect([name, ageOn(seedDay, bornDay)]).toEqual([name, age]);
      }
    }
  });

  test('the founding cast is born before day 1', () => {
    for (const age of Object.values(FOUNDING_AGES)) {
      expect(bornDayForAge(1, age)).toBeLessThan(0);
    }
  });

  test('one world-day is one year', () => {
    const bornDay = bornDayForAge(10, 30);
    expect(ageOn(11, bornDay)).toBe(31);
    expect(ageOn(40, bornDay)).toBe(60);
  });

  test('a character born today is 0, and age never goes negative', () => {
    expect(ageOn(10, 10)).toBe(0);
    expect(ageOn(9, 10)).toBe(0); // an unborn row reads as 0, not -1
  });
});

// ── Stages ──────────────────────────────────────────────────────────────────────────────────────

describe('stages', () => {
  const SPAN = 80;

  test('childhood ends at MATURITY_AGE', () => {
    expect(stageFor(MATURITY_AGE - 1, SPAN)).toBe('child');
    expect(stageFor(MATURITY_AGE, SPAN)).toBe('adult');
  });

  test('elderhood begins ELDER_WINDOW before the drawn lifespan', () => {
    expect(stageFor(SPAN - ELDER_WINDOW - 1, SPAN)).toBe('adult');
    expect(stageFor(SPAN - ELDER_WINDOW, SPAN)).toBe('elder');
    expect(stageFor(SPAN + 3, SPAN)).toBe('elder');
  });

  test('a short-lived character still gets an adulthood', () => {
    // The failure mode: if a lifespan could be drawn below MATURITY_AGE + ELDER_WINDOW, someone
    // would go straight from child to elder and never be an adult at all. The clamp forbids it.
    expect(LIFESPAN_MIN).toBeGreaterThan(MATURITY_AGE + ELDER_WINDOW);
    expect(stageFor(MATURITY_AGE, LIFESPAN_MIN)).toBe('adult');
  });

  test('no founder can begin the sim already frail, on ANY draw', () => {
    // This started red: Gloria is 52, and a 58-year draw (the clamp floor) would have made her an
    // elder on day one and killable within the first real hour — a seeding artifact, not old age.
    // seedLifespanFor is the fix, and this asserts it across every span the draw can produce.
    for (const [name, age] of Object.entries(FOUNDING_AGES)) {
      for (let drawn = LIFESPAN_MIN; drawn <= LIFESPAN_MAX; drawn++) {
        const span = seedLifespanFor(age, drawn);
        expect([name, drawn, stageFor(age, span), deathHazard(age, span)]).toEqual([
          name,
          drawn,
          'adult',
          0,
        ]);
      }
    }
  });

  test('the seed floor only ever lengthens a life', () => {
    // The failure it would hide: a floor that also CAPPED would silently shorten the lucky draws.
    for (const age of [0, 30, 52, 90, 200]) {
      for (const drawn of [LIFESPAN_MIN, LIFESPAN_MEAN, LIFESPAN_MAX]) {
        expect(seedLifespanFor(age, drawn)).toBeGreaterThanOrEqual(drawn);
      }
    }
  });
});

// ── The death hazard ────────────────────────────────────────────────────────────────────────────

describe('deathHazard', () => {
  const SPAN = 80;

  test('is exactly zero for the whole of an ordinary life', () => {
    for (let age = 0; age <= SPAN - ELDER_WINDOW; age++) {
      expect([age, deathHazard(age, SPAN)]).toEqual([age, 0]);
    }
  });

  test('reaches PEAK_HAZARD at the drawn lifespan', () => {
    expect(deathHazard(SPAN, SPAN)).toBeCloseTo(PEAK_HAZARD, 10);
  });

  test('rises monotonically once frailty begins', () => {
    let prev = -1;
    for (let age = SPAN - ELDER_WINDOW; age <= SPAN + ELDER_WINDOW; age++) {
      const h = deathHazard(age, SPAN);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });

  test('saturates, so nobody outlives their span indefinitely', () => {
    expect(deathHazard(SPAN + 6, SPAN)).toBe(1);
    expect(deathHazard(SPAN + 500, SPAN)).toBe(1);
  });

  test('the frailty stage and the hazard share one threshold', () => {
    // Awareness must not be decoration: the day they can feel it is the first day it can kill
    // them, by construction. Checked across the whole clamp range, not one span.
    for (let span = LIFESPAN_MIN; span <= LIFESPAN_MAX; span++) {
      const onset = span - ELDER_WINDOW;
      expect([span, stageFor(onset, span), deathHazard(onset - 1, span)]).toEqual([
        span,
        'elder',
        0,
      ]);
      expect(deathHazard(onset + 1, span)).toBeGreaterThan(0);
    }
  });

  test('most of a cohort dies within a few years either side of its span', () => {
    // Survival = product of (1 - hazard) across the window. This pins the SHAPE of the curve, so
    // retuning PEAK_HAZARD or ELDER_WINDOW into something degenerate (everyone dies the first
    // frail day / nobody ever dies) fails here rather than in a running town nobody is watching.
    let survival = 1;
    for (let age = SPAN - ELDER_WINDOW; age < SPAN; age++) survival *= 1 - deathHazard(age, SPAN);
    expect(survival).toBeGreaterThan(0.25); // reaching your span is not a rarity
    expect(survival).toBeLessThan(0.6); // but it is not the default either
  });
});

// ── The lifespan draw ───────────────────────────────────────────────────────────────────────────

describe('drawLifespan', () => {
  // A deterministic stand-in for Math.random, cycling a fixed sequence — so these assertions are
  // about the function, not about a lucky seed.
  const cycling = (values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length];
  };

  test('is centred on the mean', () => {
    expect(drawLifespan(cycling([0.5]))).toBe(LIFESPAN_MEAN);
  });

  test('spreads both ways', () => {
    expect(drawLifespan(cycling([0]))).toBeLessThan(LIFESPAN_MEAN);
    expect(drawLifespan(cycling([1]))).toBeGreaterThan(LIFESPAN_MEAN);
  });

  test('stays inside the clamp for any draw and any mean', () => {
    for (const mean of [10, LIFESPAN_MEAN, 1000]) {
      for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        const drawn = drawLifespan(cycling([r]), mean);
        expect([mean, r, drawn >= LIFESPAN_MIN && drawn <= LIFESPAN_MAX]).toEqual([mean, r, true]);
      }
    }
  });

  test('a cohort drawn together does not die together', () => {
    // The whole point of drawing per character. 200 draws must produce real variety.
    const spans = new Set<number>();
    for (let i = 0; i < 200; i++) spans.add(drawLifespan());
    expect(spans.size).toBeGreaterThan(10);
  });
});

// ── Transition notes ────────────────────────────────────────────────────────────────────────────

describe('stageNote', () => {
  test('names the age, so the journal entry can be concrete', () => {
    expect(stageNote('elder', 74)).toContain('74');
    expect(stageNote('adult', 16)).toContain('16');
  });

  test('the elder note says the thing plainly', () => {
    // alexa's decision: agents ARE aware they are dying. If this note ever stops saying so, the
    // awareness half of mortality is gone and nothing else would notice.
    expect(stageNote('elder', 74)!.toLowerCase()).toContain('old');
  });

  test('nobody transitions into childhood', () => {
    expect(stageNote('child', 0)).toBeNull();
  });
});
