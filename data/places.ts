// Terrarium v1.1 — PLACES (San Francisco, 2026).
//
// Semantic locations the agents know about, walk to, and reference. Coordinates are tile
// positions on the gentle map (64 wide x 48 tall, tileDim 32). The map ART is generic for
// now, so these are world-model locations (where people gather + what they call the spot),
// not literally-drawn buildings — a tilemap reskin can come later.
//
// Wired in three places:
//   - convex/aiTown/agentOperations.ts  -> chooseDestination(): agents head to their home,
//     their workplace, and shared social spots instead of a random tile.
//   - convex/agent/conversation.ts      -> nearestPlace(): adds "You're at {place}" to the
//     conversation prompt so dialogue is place-aware.
//   - src/components/PlaceLabels.tsx     -> draws labels on the map so you can see the spots.

export type Place = {
  id: string;
  name: string;
  type: 'cafe' | 'office' | 'civic' | 'culture' | 'health' | 'public' | 'home' | 'nightlife';
  description: string;
  x: number;
  y: number;
  radius: number;
  // For homes: the character who lives here.
  owner?: string;
};

const MAP_WIDTH = 64;
const MAP_HEIGHT = 48;

// Shared / public / work locations.
export const Places: Place[] = [
  {
    id: 'cafe',
    name: 'Ritual Coffee',
    type: 'cafe',
    description: `A busy Mission coffee shop where half the laptops are open to a model and
      the other half to a manifesto. Where the town runs into each other by accident.`,
    x: 22, y: 24, radius: 2,
  },
  {
    id: 'coworking',
    name: 'The Foundry',
    type: 'office',
    description: `A startup coworking floor of glass rooms and standing desks — demos, pitch
      practice, and the particular optimism of people with eighteen months of runway.`,
    x: 42, y: 16, radius: 2,
  },
  {
    id: 'lab',
    name: 'The Lab',
    type: 'office',
    description: `A frontier AI lab campus — badged doors, hushed confidence, the feeling
      that the future is being decided behind glass.`,
    x: 52, y: 28, radius: 2,
  },
  {
    id: 'cityhall',
    name: 'City Hall',
    type: 'civic',
    description: `Hearings, lobbyists in the hallway, constituents with grievances. Where the
      abstract fight over AI becomes line-items and votes.`,
    x: 30, y: 9, radius: 2,
  },
  {
    id: 'commons',
    name: 'The Commons',
    type: 'public',
    description: `A community space and worker drop-in center in the Tenderloin — free coffee,
      a job board, a back room for meetings. The town's conscience and safety net.`,
    x: 11, y: 33, radius: 2,
  },
  {
    id: 'gallery',
    name: 'Minnesota Street Studios',
    type: 'culture',
    description: `Artist studios and a gallery — openings, arguments about what counts as real
      work now, walls of things made by human hands (and some not).`,
    x: 13, y: 14, radius: 2,
  },
  {
    id: 'hospital',
    name: 'General Hospital ER',
    type: 'health',
    description: `Fluorescent, relentless, real. Twelve-hour shifts, a triage tool no one fully
      trusts, and the part of the world that doesn't care about the discourse.`,
    x: 53, y: 10, radius: 2,
  },
  {
    id: 'park',
    name: 'Dolores Park',
    type: 'public',
    description: `Grass, dogs, the whole town off-duty. Where conversations get honest and
      nobody's performing for an investor or a camera.`,
    x: 28, y: 39, radius: 3,
  },
  {
    id: 'bar',
    name: 'Zeitgeist',
    type: 'nightlife',
    description: `A loud beer garden after dark. Where the day's tensions get aired, alliances
      form, and someone always says the thing they shouldn't.`,
    x: 43, y: 38, radius: 2,
  },
];

// Each character's home, scattered around the map.
export const Homes: Place[] = [
  { id: 'home-mara', name: "Mara's place", type: 'home', owner: 'Mara', x: 24, y: 31, radius: 1, description: 'A cluttered Mission one-bedroom that doubles as a startup.' },
  { id: 'home-priya', name: "Priya's place", type: 'home', owner: 'Priya', x: 58, y: 36, radius: 1, description: 'A quiet, spare apartment close to the lab.' },
  { id: 'home-theo', name: "Theo's place", type: 'home', owner: 'Theo', x: 9, y: 21, radius: 1, description: 'A live-work studio that smells of turpentine and coffee.' },
  { id: 'home-gloria', name: "Gloria's place", type: 'home', owner: 'Gloria', x: 34, y: 18, radius: 1, description: 'A tidy flat with district maps on the wall.' },
  { id: 'home-naomi', name: "Naomi's place", type: 'home', owner: 'Naomi', x: 47, y: 23, radius: 1, description: 'Minimal, with a whiteboard of pathways by the bed.' },
  { id: 'home-desmond', name: "Desmond's place", type: 'home', owner: 'Desmond', x: 17, y: 38, radius: 1, description: 'Books in stacks, a police scanner, cold coffee.' },
  { id: 'home-yuki', name: "Yuki's place", type: 'home', owner: 'Yuki', x: 7, y: 39, radius: 1, description: 'A warm place where neighbors always seem to be over.' },
  { id: 'home-russ', name: "Russ's place", type: 'home', owner: 'Russ', x: 58, y: 12, radius: 1, description: "A lived-in apartment with a kid's drawings on the fridge." },
];

// Which place each character works at.
export const WorkplaceId: Record<string, string> = {
  Mara: 'coworking',
  Priya: 'lab',
  Theo: 'gallery',
  Gloria: 'cityhall',
  Naomi: 'coworking',
  Desmond: 'cafe',
  Yuki: 'commons',
  Russ: 'hospital',
};

const ALL_PLACES = [...Places, ...Homes];

export function homeFor(character: string): Place | undefined {
  return Homes.find((h) => h.owner === character);
}

export function workFor(character: string): Place | undefined {
  const id = WorkplaceId[character];
  return id ? Places.find((p) => p.id === id) : undefined;
}

// The named place a tile is "at", or undefined if out in the open. Closest within radius wins.
export function nearestPlace(x: number, y: number): Place | undefined {
  let best: Place | undefined;
  let bestDist = Infinity;
  for (const p of ALL_PLACES) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= p.radius + 0.5 && d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Pick where a character heads next: biased toward their own home + workplace, otherwise a
// shared spot to mingle. A little jitter so people don't stack on the exact same tile.
export function chooseDestination(
  character: string,
  width = MAP_WIDTH,
  height = MAP_HEIGHT,
): { x: number; y: number } {
  const home = homeFor(character);
  const work = workFor(character);
  const r = Math.random();
  let target: Place;
  if (home && r < 0.3) {
    target = home;
  } else if (work && r < 0.6) {
    target = work;
  } else {
    target = Places[Math.floor(Math.random() * Places.length)];
  }
  const jitter = () => Math.round((Math.random() - 0.5) * 2 * target.radius);
  return {
    x: clamp(target.x + jitter(), 1, width - 2),
    y: clamp(target.y + jitter(), 1, height - 2),
  };
}

export default Places;
