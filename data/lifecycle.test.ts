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
  deathNotice,
  diesOfAgeOn,
  drawLifespan,
  identityAtAge,
  identityStatesAge,
  othersSeeStage,
  seedLifespanFor,
  stageFor,
  stageNote,
  stagePromptLine,
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

// ── The death decision ──────────────────────────────────────────────────────────────────────────

describe('diesOfAgeOn', () => {
  const SPAN = 80;

  test('no roll can kill a character who is not yet frail', () => {
    // The property that matters most: a character can never die on a day they could not already
    // feel coming. Zero hazard must mean zero deaths, INCLUDING on a roll of exactly 0 — which a
    // `<=` comparison would have killed.
    for (let age = 0; age <= SPAN - ELDER_WINDOW; age++) {
      for (const roll of [0, 0.0001, 0.5, 0.9999]) {
        expect([age, roll, diesOfAgeOn(age, SPAN, roll)]).toEqual([age, roll, false]);
      }
    }
  });

  test('the boundary is the hazard, exactly', () => {
    const age = SPAN;
    const h = deathHazard(age, SPAN);
    expect(diesOfAgeOn(age, SPAN, h - 1e-9)).toBe(true);
    expect(diesOfAgeOn(age, SPAN, h)).toBe(false); // strictly less-than
    expect(diesOfAgeOn(age, SPAN, h + 1e-9)).toBe(false);
  });

  test('a character far past their span dies on any roll', () => {
    for (const roll of [0, 0.5, 0.999999]) {
      expect(diesOfAgeOn(SPAN + 6, SPAN, roll)).toBe(true);
    }
  });

  test('dying and feeling old start on the same day', () => {
    // Same assertion as the hazard test, but stated over the DECISION, because this is the pair a
    // future retune could quietly break: shift one threshold and characters start dropping dead
    // while still described to themselves as middle-aged.
    for (let span = LIFESPAN_MIN; span <= LIFESPAN_MAX; span++) {
      const onset = span - ELDER_WINDOW;
      expect([span, diesOfAgeOn(onset - 1, span, 0)]).toEqual([span, false]);
      expect([span, stageFor(onset, span)]).toEqual([span, 'elder']);
    }
  });

  test('a whole cohort dies inside the window and none survive it', () => {
    // Walks 500 characters through one day at a time from frailty onset and checks that every one
    // of them is dead by span + ELDER_WINDOW. An immortal here would mean the town fills up with
    // people who cannot die.
    let maxAge = 0;
    for (let i = 0; i < 500; i++) {
      let age = SPAN - ELDER_WINDOW;
      while (!diesOfAgeOn(age, SPAN, Math.random())) {
        age++;
        if (age > SPAN + ELDER_WINDOW) break;
      }
      maxAge = Math.max(maxAge, age);
    }
    expect(maxAge).toBeLessThanOrEqual(SPAN + 6);
  });
});

describe('deathNotice', () => {
  test('names the person and their age', () => {
    expect(deathNotice('Russ', 78)).toContain('Russ');
    expect(deathNotice('Russ', 78)).toContain('78');
  });
});

// ── Age in the prompt ───────────────────────────────────────────────────────────────────────────

describe('identityAtAge', () => {
  test('rewrites every founding bio to the current age', () => {
    // The whole point: the bio is read to the model as self-description on every prompt, so after
    // aging it must not still claim the age they started at.
    for (const d of Descriptions) {
      const out = identityAtAge(d.identity, 77);
      expect([d.name, ageFromIdentity(out)]).toEqual([d.name, 77]);
    }
  });

  test('leaves the rest of the prose byte-identical', () => {
    // Guards against a regex that eats more than the number. alexa wrote this text; the only thing
    // this function may touch is the digits.
    for (const d of Descriptions) {
      const original = FOUNDING_AGES[d.name];
      expect(identityAtAge(identityAtAge(d.identity, 77), original)).toBe(d.identity);
    }
  });

  test('handles a three-digit age', () => {
    // A plain boundary case for the rewrite, and nothing more. It was written to catch a
    // `"$1" + age` replacement-string hazard; planting that exact defect left the suite green,
    // and checking directly showed the hazard is not real. Kept as a boundary test, with the
    // claim it used to make removed.
    expect(identityAtAge("I'm Mara, 31, an indie founder", 104)).toBe(
      "I'm Mara, 104, an indie founder",
    );
    expect(identityAtAge("I'm Mara, 31, an indie founder", 53)).toBe(
      "I'm Mara, 53, an indie founder",
    );
  });

  test('is stable across repeated calls', () => {
    // A global regex would carry lastIndex between calls and skip every second one.
    const bio = "I'm Theo, 29, an illustrator";
    for (let i = 0; i < 5; i++) expect(identityAtAge(bio, 60)).toBe("I'm Theo, 60, an illustrator");
  });

  test('a bio with no stated age is returned untouched and flagged', () => {
    const bio = 'A quiet person who grew up here.';
    expect(identityStatesAge(bio)).toBe(false);
    expect(identityAtAge(bio, 40)).toBe(bio);
    for (const d of Descriptions) expect(identityStatesAge(d.identity)).toBe(true);
  });
});

describe('stagePromptLine', () => {
  const SPAN = 80;

  test('an adult is told nothing extra', () => {
    // Their age already lives in the rewritten bio. A second statement is the duplication this
    // whole design exists to avoid.
    expect(stagePromptLine('adult', 40, SPAN)).toBeNull();
  });

  test('an elder is told, and the wording escalates as the hazard rises', () => {
    const onset = SPAN - ELDER_WINDOW;
    const early = stagePromptLine('elder', onset + 1, SPAN)!;
    const late = stagePromptLine('elder', SPAN, SPAN)!;
    const end = stagePromptLine('elder', SPAN + 6, SPAN)!;
    expect(early).not.toBe(late);
    expect(late).not.toBe(end);
    // alexa's decision: agents ARE aware they are dying. The deepest line must say so.
    expect(end.toLowerCase()).toContain('end of your life');
  });

  test('every elder line states the age and no line quotes a countdown', () => {
    // A character who knows they have "4 years left" is reading their own database row.
    for (let age = SPAN - ELDER_WINDOW; age <= SPAN + ELDER_WINDOW; age++) {
      const line = stagePromptLine('elder', age, SPAN)!;
      expect([age, line.includes(String(age))]).toEqual([age, true]);
      expect([age, /years left|remaining|lifespan/i.test(line)]).toEqual([age, false]);
    }
  });

  test('a child is told they are a child', () => {
    expect(stagePromptLine('child', 8, SPAN)).toContain('child');
  });
});

describe('othersSeeStage', () => {
  test('only the visible stages are described to other people', () => {
    expect(othersSeeStage('Russ', 'adult', 40)).toBeNull();
    expect(othersSeeStage('Russ', 'elder', 78)).toContain('Russ');
    expect(othersSeeStage('Russ', 'elder', 78)).toContain('78');
    expect(othersSeeStage('Ada', 'child', 9)).toContain('child');
  });
});
