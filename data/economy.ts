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
  Priya: 22, // frontier AI lab researcher
  Mara: 18, // startup founder (lumpy, but good days)
  Russ: 20, // ER physician
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
