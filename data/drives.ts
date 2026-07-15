// Terrarium v2.1 — DRIVES (the inner motivational dial).
//
// Beliefs (v1.8) say what a character thinks; DRIVES say what moves them. Each character has a
// weighted profile over a small set of motivations, seeded from who they are. The same mechanics
// — needs, leisure, mood, goals, how others' success lands — run for everyone, but the WEIGHTS
// differ, so a high-ambition founder and a connection-driven organizer experience the identical
// world very differently. This is what keeps the stakes from feeling uniform or performative:
// pressure is felt through each character's own drives.
//
// Wired in: convex/drives.ts (storage + seeding), convex/mood.ts (drives weight the stress/
// momentum roll-up), convex/goals.ts (long-term aspiration is seeded here), and the leisure
// need in agentOperations.tickVitals (drain + tolerance are drive-set).

export type DriveKey =
  | 'ambition' // to build/achieve something big
  | 'recognition' // to be seen, respected, to matter publicly
  | 'connection' // closeness, belonging, being needed by others
  | 'security' // stability, money, not being at risk
  | 'autonomy' // freedom to do it their own way
  | 'craft' // mastery, the work being good for its own sake
  | 'principle'; // a cause / being on the right side

// 0..100 weights. They don't need to sum to anything; what matters is the relative shape.
export type DriveProfile = Partial<Record<DriveKey, number>>;

export type DriveSeed = {
  profile: DriveProfile;
  // The far-horizon thing they're oriented toward (seeded as their long-term goal in v2.1).
  aspiration: string;
  // Roughly how many world-days out the aspiration sits (the long-term deadline).
  horizonDays: number;
};

export const DRIVE_SEEDS: Record<string, DriveSeed> = {
  Mara: {
    profile: {
      ambition: 90,
      recognition: 75,
      autonomy: 80,
      craft: 55,
      connection: 45,
      security: 30,
      principle: 35,
    },
    aspiration:
      'Build my app into something thousands of people rely on — and prove a small builder can still win.',
    horizonDays: 30,
  },
  Priya: {
    profile: {
      principle: 82,
      craft: 78,
      recognition: 55,
      security: 50,
      ambition: 55,
      autonomy: 50,
      connection: 40,
    },
    aspiration:
      'Help shape how powerful models get released so the transition does not hurt people — and be heard doing it.',
    horizonDays: 30,
  },
  Theo: {
    profile: {
      craft: 92,
      autonomy: 82,
      principle: 70,
      connection: 50,
      recognition: 48,
      ambition: 30,
      security: 25,
    },
    aspiration:
      'Make a body of work that is undeniably human — that no machine could have made — and have it truly seen.',
    horizonDays: 30,
  },
  Gloria: {
    profile: {
      principle: 90,
      connection: 72,
      recognition: 65,
      security: 50,
      ambition: 50,
      autonomy: 35,
      craft: 40,
    },
    aspiration:
      'Pass real, enforceable AI accountability that actually protects the workers it affects.',
    horizonDays: 35,
  },
  Naomi: {
    profile: {
      craft: 85,
      principle: 70,
      ambition: 58,
      recognition: 55,
      security: 50,
      autonomy: 50,
      connection: 35,
    },
    aspiration:
      'Turn one AI-for-discovery result into something rigorously validated and published.',
    horizonDays: 30,
  },
  Desmond: {
    profile: {
      principle: 88,
      autonomy: 80,
      recognition: 60,
      ambition: 55,
      craft: 55,
      connection: 35,
      security: 30,
    },
    aspiration:
      'Break the story that makes a powerful institution answer for what it is doing with AI.',
    horizonDays: 28,
  },
  Yuki: {
    profile: {
      connection: 92,
      principle: 78,
      security: 50,
      autonomy: 45,
      recognition: 35,
      ambition: 35,
      craft: 40,
    },
    aspiration:
      'Build the Commons into a place strong enough to hold the neighborhood together through the disruption.',
    horizonDays: 30,
  },
  Russ: {
    profile: {
      security: 80,
      principle: 78,
      craft: 75,
      connection: 55,
      autonomy: 45,
      recognition: 30,
      ambition: 30,
    },
    aspiration:
      'Stay excellent at the work that actually matters, and keep my corner of the ER human.',
    horizonDays: 25,
  },
};

export function driveSeedFor(name: string): DriveSeed | null {
  return DRIVE_SEEDS[name] ?? null;
}

const w = (p: DriveProfile, k: DriveKey) => p[k] ?? 0;
const norm = (x: number) => Math.max(0, Math.min(1, x / 100));

// The two or three loudest drives, for prompts + UI ("what drives you").
export function topDrives(profile: DriveProfile, n = 3): { key: DriveKey; weight: number }[] {
  return (Object.entries(profile) as [DriveKey, number][])
    .map(([key, weight]) => ({ key, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, n);
}

// LEISURE: how fast the fun/leisure need drains per waking tick. Connection-driven people need
// downtime with others or they fray; pure-ambition people run hot and barely notice. ~2.5..6.
export function leisureDrainFor(profile: DriveProfile): number {
  const base = 3.5;
  const pull = norm(w(profile, 'connection')) * 2.5 - norm(w(profile, 'ambition')) * 1.5;
  return Math.max(2, base + pull);
}

// How much a leisure DEFICIT converts into stress (0..~1.3). High ambition tolerates running on
// empty; high connection makes a starved leisure bar bite hard.
export function leisureIntoleranceFor(profile: DriveProfile): number {
  return 0.6 + norm(w(profile, 'connection')) * 0.7 - norm(w(profile, 'ambition')) * 0.4;
}

// How willing they are to SKIP leisure to keep working (0..1). Ambition + recognition push work;
// connection pulls toward stopping. Used to bias the work-vs-rest choice.
export function workOverLeisureFor(profile: DriveProfile): number {
  return Math.max(
    0,
    Math.min(
      1,
      0.4 +
        norm(w(profile, 'ambition')) * 0.5 +
        norm(w(profile, 'recognition')) * 0.2 -
        norm(w(profile, 'connection')) * 0.4,
    ),
  );
}

// How much relative STANDING (who's getting recognized around town) moves their mood. Recognition
// + ambition make rank land hard; a Yuki or Russ barely tracks it. 0..~1.3.
export function recognitionSensitivityFor(profile: DriveProfile): number {
  return norm(w(profile, 'recognition')) * 0.9 + norm(w(profile, 'ambition')) * 0.4;
}

// How much MONEY/stability deficits weigh on them. Security-driven feel a thin wallet as real
// stress; others shrug it off more. 0.4..~1.3.
export function securityWeightFor(profile: DriveProfile): number {
  return 0.4 + norm(w(profile, 'security')) * 0.9;
}

// How strongly they're pulled to HOST/seek gatherings (grow influence, be among people). Driven
// by recognition (be seen) + connection (be together). 0..1.
export function gatheringPullFor(profile: DriveProfile): number {
  return Math.min(1, norm(w(profile, 'recognition')) * 0.6 + norm(w(profile, 'connection')) * 0.6);
}

const DRIVE_LABELS: Record<DriveKey, string> = {
  ambition: 'building something big',
  recognition: 'being seen and respected',
  connection: 'closeness and belonging',
  security: 'stability and not being at risk',
  autonomy: 'doing it your own way',
  craft: 'mastery — the work being good for its own sake',
  principle: 'being on the right side of things',
};

export function driveLabel(key: DriveKey): string {
  return DRIVE_LABELS[key];
}
