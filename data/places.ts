// Terrarium v1.1 — PLACES (San Francisco, 2026).
//
// Semantic locations the agents know about, can go to, and reference. This file is
// CONTENT only — it is not yet imported by the engine. The v1.1 mechanics chunk wires
// it in (see docs/V1.1-WORLD.md §Places): a `places` table + place-aware navigation in
// `convex/aiTown/agentOperations.ts`, and a "you're at {place}" line in the prompt
// assembled by `convex/agent/conversation.ts`.
//
// `x`/`y` are tile coordinates on the world map and must be set against the actual
// tilemap on the Mini (open the map, read coords). Left null here as TODO. `radius` is
// how close (in tiles) counts as "at" the place. `tags` hint which roles gravitate here.

export type Place = {
  id: string;
  name: string;
  type: 'cafe' | 'office' | 'civic' | 'culture' | 'health' | 'public' | 'home' | 'nightlife';
  description: string;
  x: number | null;
  y: number | null;
  radius: number;
  tags: string[];
};

export const Places: Place[] = [
  {
    id: 'cafe',
    name: 'Ritual Coffee',
    type: 'cafe',
    description: `A busy Mission coffee shop where half the laptops are open to a model
      and the other half to a manifesto. Where the town runs into each other by accident.`,
    x: null, y: null, radius: 2,
    tags: ['desmond', 'mara', 'social', 'work'],
  },
  {
    id: 'coworking',
    name: 'The Foundry (coworking)',
    type: 'office',
    description: `A startup coworking floor of glass rooms and standing desks. Demos,
      pitch practice, and the particular optimism of people with eighteen months of runway.`,
    x: null, y: null, radius: 2,
    tags: ['mara', 'naomi', 'work', 'build'],
  },
  {
    id: 'lab',
    name: 'The Lab',
    type: 'office',
    description: `A frontier AI lab campus — badged doors, hushed confidence, the feeling
      that the future is being decided behind glass. Few townspeople ever go inside.`,
    x: null, y: null, radius: 2,
    tags: ['priya', 'work'],
  },
  {
    id: 'cityhall',
    name: 'City Hall',
    type: 'civic',
    description: `Hearings, lobbyists in the hallway, constituents with grievances.
      Where the abstract fight over AI becomes specific line-items and votes.`,
    x: null, y: null, radius: 2,
    tags: ['gloria', 'desmond', 'yuki', 'policy'],
  },
  {
    id: 'commons',
    name: 'The Commons',
    type: 'public',
    description: `A community space and worker drop-in center in the Tenderloin — free
      coffee, a job board, a back room for meetings. The town's conscience and its safety net.`,
    x: null, y: null, radius: 2,
    tags: ['yuki', 'russ', 'community'],
  },
  {
    id: 'gallery',
    name: 'Minnesota Street Studios',
    type: 'culture',
    description: `Artist studios and a gallery — openings, arguments about what counts as
      real work now, walls of things made by human hands (and some not).`,
    x: null, y: null, radius: 2,
    tags: ['theo', 'culture'],
  },
  {
    id: 'hospital',
    name: 'General Hospital ER',
    type: 'health',
    description: `Fluorescent, relentless, real. Twelve-hour shifts, a triage tool no one
      fully trusts, and the part of the world that doesn't care about the discourse.`,
    x: null, y: null, radius: 2,
    tags: ['russ', 'work'],
  },
  {
    id: 'park',
    name: 'Dolores Park',
    type: 'public',
    description: `Grass, dogs, the whole town off-duty. Where conversations get honest and
      nobody's performing for an investor or a camera.`,
    x: null, y: null, radius: 3,
    tags: ['social', 'rest'],
  },
  {
    id: 'bar',
    name: 'Zeitgeist',
    type: 'nightlife',
    description: `A loud beer garden after dark. Where the day's tensions get aired,
      alliances form, and someone always says the thing they shouldn't.`,
    x: null, y: null, radius: 2,
    tags: ['social', 'evening'],
  },
];

export default Places;
