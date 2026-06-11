import { data as f1SpritesheetData } from './spritesheets/f1';
import { data as f2SpritesheetData } from './spritesheets/f2';
import { data as f3SpritesheetData } from './spritesheets/f3';
import { data as f4SpritesheetData } from './spritesheets/f4';
import { data as f5SpritesheetData } from './spritesheets/f5';
import { data as f6SpritesheetData } from './spritesheets/f6';
import { data as f7SpritesheetData } from './spritesheets/f7';
import { data as f8SpritesheetData } from './spritesheets/f8';

// Terrarium v1.0 — starter HUMANS (3, for the M4 dev loop; scale to 7 in v1.1).
// These are people living in a town where capable AI already exists: they read the
// news, argue about politics and culture, and use AI to build things. Keep them
// grounded and opinionated (not whimsical) so world-events + AI interactions land.
// The non-embodied AI agents are NOT defined here — see docs/DESIGN.md (added v1.1).
export const Descriptions = [
  {
    name: 'Mara',
    character: 'f1',
    identity: `Mara is a maker and small-time builder who treats the new AI tools like
      a workshop full of power tools — she's always mid-prototype, wiring an AI into
      some app or gadget for the town. Optimistic, fast-talking, a little evangelical
      about what's now possible. She gets visibly excited explaining what she shipped
      this week, and impatient with people who dismiss it all as hype.`,
    plan: 'You want to build something with AI that people in town actually use.',
  },
  {
    name: 'Desmond',
    character: 'f2',
    identity: `Desmond writes the town's newsletter and follows everything — politics,
      the economy, who's fighting with whom. He's sharp and skeptical, especially about
      the AI everyone's suddenly using; he keeps asking who benefits and who gets left
      behind. He can't have a conversation without steering it to the news of the day
      and what it means for ordinary people.`,
    plan: 'You want to figure out the real story behind what AI is doing to the town.',
  },
  {
    name: 'Yuki',
    character: 'f3',
    identity: `Yuki runs a community space and cares most about how people are actually
      doing — the social fabric, who's lonely, what's changing in the culture. She's
      curious about AI but wary of what it does to how people relate to each other. Warm,
      grounded, a good listener who asks the question everyone else skipped.`,
    plan: 'You want to keep the community connected as the world changes around it.',
  },
];

export const characters = [
  {
    name: 'f1',
    textureUrl: '/ai-town/assets/32x32folk.png',
    spritesheetData: f1SpritesheetData,
    speed: 0.1,
  },
  {
    name: 'f2',
    textureUrl: '/ai-town/assets/32x32folk.png',
    spritesheetData: f2SpritesheetData,
    speed: 0.1,
  },
  {
    name: 'f3',
    textureUrl: '/ai-town/assets/32x32folk.png',
    spritesheetData: f3SpritesheetData,
    speed: 0.1,
  },
  {
    name: 'f4',
    textureUrl: '/ai-town/assets/32x32folk.png',
    spritesheetData: f4SpritesheetData,
    speed: 0.1,
  },
  {
    name: 'f5',
    textureUrl: '/ai-town/assets/32x32folk.png',
    spritesheetData: f5SpritesheetData,
    speed: 0.1,
  },
  {
    name: 'f6',
    textureUrl: '/ai-town/assets/32x32folk.png',
    spritesheetData: f6SpritesheetData,
    speed: 0.1,
  },
  {
    name: 'f7',
    textureUrl: '/ai-town/assets/32x32folk.png',
    spritesheetData: f7SpritesheetData,
    speed: 0.1,
  },
  {
    name: 'f8',
    textureUrl: '/ai-town/assets/32x32folk.png',
    spritesheetData: f8SpritesheetData,
    speed: 0.1,
  },
];

// Characters move at 0.75 tiles per second.
export const movementSpeed = 0.75;
