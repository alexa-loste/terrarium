// Terrarium v1.4 — ECONOMY + NEEDS (money, food, wages).
//
// The material base of the town: people get hungry, work their jobs for money, and spend it
// on food. Incomes differ by job, so wealth stratifies over days. All tunable here.
//
// Wired in convex/aiTown/agentOperations.ts (tickVitals): during work hours, working at your
// workplace pays your wage; when hungry, you eat (refills food, costs money by where you are).

// Per work-tick wage by character, reflecting (relative) San Francisco realities. A "work-tick"
// is one idle decision taken while at your workplace during work hours.
export const WAGES: Record<string, number> = {
  Priya: 26, // frontier AI lab researcher — top earner
  Mara: 18, // startup founder (lumpy, but good days)
  Russ: 17, // ER nurse — solid, stable
  Naomi: 16, // applied researcher / coworking
  Gloria: 14, // city hall staffer
  Theo: 9, // artist
  Desmond: 9, // cafe + freelance journalism
  Yuki: 7, // community organizer at the Commons
};
export const DEFAULT_WAGE = 10;

export function wageFor(character: string): number {
  return WAGES[character] ?? DEFAULT_WAGE;
}

export const STARTING_MONEY = 80;

// v2.5 — REALISTIC WEALTH + the disparity engine.
//
// Why this exists: until now ALL income was per-tick wages that only accrued while an agent happened
// to be standing on their workplace tile during work hours. So realized wealth was dominated by
// movement/attendance NOISE, not the income structure — Priya's high wage only counted on the ticks
// she was at the lab. The income gap couldn't propagate; wealth was a noisy random walk floored at 0.
//
// Fix: (1) seed each character's liquid savings to a realistic, career-tiered net worth; (2) credit a
// reliable DAILY_SAVINGS each world-day (net of living costs — the wealth that actually compounds),
// independent of tick-level attendance, so disparity diverges monotonically; (3) make money-stress
// relative to each persona's COST_OF_LIVING (buffer-days), so the precarious still feel the pinch at
// the larger scale while the comfortable don't. Tick-wages + food stay as short-term cash-flow texture
// — now a ripple on a structural, tiered base instead of the whole signal.

// Accumulated liquid savings at the start (career net worth, SF-realistic tiers, sim $).
export const REALISTIC_WEALTH: Record<string, number> = {
  Priya: 2900, // frontier-lab researcher — clearly the top earner/saver
  Russ: 1500, // ER nurse, 47 — long stable career, solid savings
  Mara: 1450, // founder — comfortable but cash plowed into the startup
  Naomi: 1100, // applied researcher
  Gloria: 640, // city-hall salary, stable but modest
  Desmond: 240, // cafe + freelance journalism — precarious
  Theo: 185, // artist — precarious
  Yuki: 130, // community organizer — lowest paid
};
export const DEFAULT_WEALTH = 300;

export function realisticWealthFor(character: string): number {
  return REALISTIC_WEALTH[character] ?? DEFAULT_WEALTH;
}

// Net savings added to the wallet ONCE PER WORLD-DAY (the wealth that compounds after living costs).
// This is the divergence engine — reliable and tiered, so it dominates the tick-wage noise over time.
export const DAILY_SAVINGS: Record<string, number> = {
  Priya: 60, // top earner saves the most
  Mara: 34,
  Russ: 30, // solid nurse income, but below a frontier-lab salary
  Naomi: 28,
  Gloria: 15,
  Desmond: 6,
  Theo: 5,
  Yuki: 3,
};
export const DEFAULT_DAILY_SAVINGS = 8;

export function dailySavingsFor(character: string): number {
  return DAILY_SAVINGS[character] ?? DEFAULT_DAILY_SAVINGS;
}

// A persona's daily cost of living — used to read money-stress as a BUFFER (how many days of living
// costs you have saved), not an absolute floor. The precarious have thin buffers and feel it.
export const COST_OF_LIVING: Record<string, number> = {
  Priya: 66,
  Mara: 52,
  Russ: 46,
  Naomi: 44,
  Gloria: 30,
  Desmond: 22,
  Theo: 20,
  Yuki: 16,
};
export const DEFAULT_COL = 25;

export function costOfLivingFor(character: string): number {
  return COST_OF_LIVING[character] ?? DEFAULT_COL;
}

// Money-stress as a function of saved BUFFER (days of living costs), scaled by how much security
// matters to this character. Returns a stress amount on the same scale as the old absolute term.
// Comfortable buffers (>= SECURE_BUFFER_DAYS) → no money stress; thin buffers ramp up.
export const SECURE_BUFFER_DAYS = 12;
export function moneyStress(money: number, costOfLiving: number, securityWeight: number): number {
  const bufferDays = money / Math.max(1, costOfLiving);
  if (bufferDays >= SECURE_BUFFER_DAYS) return 0;
  return ((SECURE_BUFFER_DAYS - bufferDays) / SECURE_BUFFER_DAYS) * 26 * securityWeight;
}

// Needs: food drains each waking tick; a meal refills it. Eating triggers below the threshold.
export const MAX_FOOD = 100;
export const FOOD_DRAIN = 5;
export const HUNGRY_THRESHOLD = 35;
export const MEAL_FOOD = MAX_FOOD;

// A meal costs more out than at home. `placeType` comes from data/places.ts nearestPlace().
export function mealCost(placeType?: string): number {
  switch (placeType) {
    case 'home':
      return 4;
    case 'cafe':
      return 12;
    case 'nightlife': // the bar
      return 16;
    case 'public': // park food cart, etc.
      return 9;
    default:
      return 8; // grabbing something wherever you are
  }
}
