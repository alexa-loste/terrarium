// Terrarium v1.6 — ARTIFACTS (real work output).
//
// The point of working a job shouldn't only be the wage — it should leave something behind.
// When an agent works during the day they sometimes PRODUCE a genuine, role-specific piece of
// work: the local LLM actually writes a research note, a policy memo, an article, a painting
// description, a case note, etc. It persists in the `artifacts` table (surviving the lossy
// memory-gisting), shows up in the town Library, becomes a memory for its author, and can
// respond to what others recently published — so a real discourse / progress chain forms.
//
// Wired in convex/aiTown/agentOperations.ts (maybeMakeArtifact) + convex/aiTown/agentComms.ts
// (composeArtifact). Each character makes the kind of thing their actual work produces.

export type WorkOutput = {
  // The noun for the thing produced (shown as the artifact's type label).
  workType: string;
  emoji: string;
  // The present-progressive activity shown on the map/roster while making it.
  activity: string;
  // The instruction handed to the LLM describing what to produce, in their voice.
  brief: string;
};

const DEFAULT_OUTPUT: WorkOutput = {
  workType: 'note',
  emoji: '🗒️',
  activity: 'writing something up',
  brief: 'a short piece of work reflecting what you do and what is on your mind today',
};

export const WORK_OUTPUTS: Record<string, WorkOutput> = {
  Priya: {
    workType: 'research note',
    emoji: '🔬',
    activity: 'writing up a result',
    brief:
      'a short frontier-AI research note — a finding, a hypothesis, a result, or an open ' +
      'question from your work at the lab. Concrete and technical, but readable.',
  },
  Mara: {
    workType: 'product note',
    emoji: '🚀',
    activity: 'speccing a feature',
    brief:
      'a short startup product note — a feature idea, a build update, a pitch angle, or what ' +
      'you learned from a user this week. Sharp and decisive.',
  },
  Russ: {
    workType: 'case note',
    emoji: '🩺',
    activity: 'charting a case',
    brief:
      'a short, anonymized case note or reflection from your ER shift — something clinical you ' +
      'saw, a judgment call, or how the triage tool did or did not help. Grounded, human.',
  },
  Naomi: {
    workType: 'analysis',
    emoji: '📊',
    activity: 'running an analysis',
    brief:
      'a short applied-research memo — an analysis, a measurement, or a practical takeaway from ' +
      'the data you work with. Careful and evidence-first.',
  },
  Gloria: {
    workType: 'policy memo',
    emoji: '🏛️',
    activity: 'drafting a memo',
    brief:
      'a short policy memo from City Hall — a proposal, a constituent issue, or a line-item ' +
      'fight over how the city should handle AI. Practical, accountable to real people.',
  },
  Theo: {
    workType: 'artwork',
    emoji: '🎨',
    activity: 'painting',
    brief:
      'a short description of a new piece you just made (a painting, an installation, a sketch) ' +
      '— what it is, what it is about, and why you made it now. Vivid; it is about meaning.',
  },
  Desmond: {
    workType: 'dispatch',
    emoji: '📰',
    activity: 'filing a story',
    brief:
      'a short journalistic dispatch about the town — something you noticed, reported, or want ' +
      'people to know. A real lede and a point of view. Skeptical, on the side of readers.',
  },
  Yuki: {
    workType: 'community notice',
    emoji: '📋',
    activity: 'organizing',
    brief:
      'a short community notice or organizing note from the Commons — a meeting, a resource, a ' +
      'call to action, or who needs help. Warm, concrete, neighbor-to-neighbor.',
  },
};

export function workOutputFor(character: string): WorkOutput {
  return WORK_OUTPUTS[character] ?? DEFAULT_OUTPUT;
}
