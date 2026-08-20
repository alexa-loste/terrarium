import { ConvexError, Infer, Value, v } from 'convex/values';
import { Doc, Id } from '../_generated/dataModel';
import { ActionCtx, DatabaseReader, MutationCtx, internalQuery } from '../_generated/server';
import { engine } from '../engine/schema';
import { internal } from '../_generated/api';

export abstract class AbstractGame {
  abstract tickDuration: number;
  abstract stepDuration: number;
  abstract maxTicksPerStep: number;
  abstract maxInputsPerStep: number;

  constructor(public engine: Doc<'engines'>) {}

  abstract handleInput(now: number, name: string, args: object): Value;
  abstract tick(now: number): void;

  // Optional callback at the beginning of each step.
  beginStep(now: number) {}
  abstract saveStep(ctx: ActionCtx, engineUpdate: EngineUpdate): Promise<void>;

  async runStep(ctx: ActionCtx, now: number) {
    const inputs = await ctx.runQuery(internal.engine.abstractGame.loadInputs, {
      engineId: this.engine._id,
      processedInputNumber: this.engine.processedInputNumber,
      max: this.maxInputsPerStep,
    });

    const lastStepTs = this.engine.currentTime;
    const startTs = lastStepTs ? lastStepTs + this.tickDuration : now;
    let currentTs = startTs;
    let inputIndex = 0;
    let numTicks = 0;
    let processedInputNumber = this.engine.processedInputNumber;
    const completedInputs = [];

    this.beginStep(currentTs);

    while (numTicks < this.maxTicksPerStep) {
      numTicks += 1;

      // Collect all of the inputs for this tick.
      const tickInputs = [];
      while (inputIndex < inputs.length) {
        const input = inputs[inputIndex];
        if (input.received > currentTs) {
          break;
        }
        inputIndex += 1;
        processedInputNumber = input.number;
        tickInputs.push(input);
      }

      // Feed the inputs to the game.
      for (const input of tickInputs) {
        let returnValue;
        try {
          const value = this.handleInput(currentTs, input.name, input.args);
          returnValue = { kind: 'ok' as const, value };
        } catch (e: any) {
          console.error(`Input ${input._id} failed: ${e.message}`);
          returnValue = { kind: 'error' as const, message: e.message };
        }
        completedInputs.push({ inputId: input._id, returnValue });
      }

      // Simulate the game forward one tick.
      this.tick(currentTs);

      const candidateTs = currentTs + this.tickDuration;
      if (now < candidateTs) {
        break;
      }
      currentTs = candidateTs;
    }

    // Commit the step by moving time forward, consuming our inputs, and saving the game's state.
    const expectedGenerationNumber = this.engine.generationNumber;
    this.engine.currentTime = currentTs;
    this.engine.lastStepTs = lastStepTs;
    this.engine.generationNumber += 1;
    this.engine.processedInputNumber = processedInputNumber;
    const { _id, _creationTime, ...engine } = this.engine;
    const engineUpdate = { engine, completedInputs, expectedGenerationNumber };
    await this.saveStep(ctx, engineUpdate);

    console.debug(`Simulated from ${startTs} to ${currentTs} (${currentTs - startTs}ms)`);
  }
}

const completedInput = v.object({
  inputId: v.id('inputs'),
  returnValue: v.union(
    v.object({
      kind: v.literal('ok'),
      value: v.any(),
    }),
    v.object({
      kind: v.literal('error'),
      message: v.string(),
    }),
  ),
});

export const engineUpdate = v.object({
  engine,
  expectedGenerationNumber: v.number(),
  completedInputs: v.array(completedInput),
});
export type EngineUpdate = Infer<typeof engineUpdate>;

export async function loadEngine(
  db: DatabaseReader,
  engineId: Id<'engines'>,
  generationNumber: number,
) {
  const engine = await db.get(engineId);
  if (!engine) {
    throw new Error(`No engine found with id ${engineId}`);
  }
  if (!engine.running) {
    throw new ConvexError({
      kind: 'engineNotRunning',
      message: `Engine ${engineId} is not running`,
    });
  }
  if (engine.generationNumber !== generationNumber) {
    throw new ConvexError({ kind: 'generationNumber', message: 'Generation number mismatch' });
  }
  return engine;
}

export async function engineInsertInput(
  ctx: MutationCtx,
  engineId: Id<'engines'>,
  name: string,
  args: any,
): Promise<Id<'inputs'>> {
  const now = Date.now();
  const prevInput = await ctx.db
    .query('inputs')
    .withIndex('byInputNumber', (q) => q.eq('engineId', engineId))
    .order('desc')
    .first();
  // The input number must be derived from the ENGINE's watermark as well as from the surviving
  // rows, never from the rows alone.
  //
  // THE INCIDENT (2026-08-20). `inputs` is vacuumed daily (convex/crons.ts) and the world had been
  // idle for weeks, so every row aged out and the table emptied. This function then handed the next
  // input number 0 — while `engine.processedInputNumber` still stood at 34208 from before the
  // sweep. `loadInputs` only returns inputs numbered ABOVE that watermark, so from that moment the
  // engine could not see a single input it received, and never would: numbering climbs by one per
  // input and the watermark was 34208 ahead.
  //
  // The town did not look broken, which is the worst part of it. Ticks kept running, the model kept
  // answering, messages kept appearing (agentSendMessage writes the row directly rather than
  // through an input). What silently stopped was every state TRANSITION: no agent operation could
  // ever complete, so all seven agents timed out in lockstep every ACTION_TIMEOUT and retried
  // forever, and one conversation reached 124 messages against a cap of 8 because the `leave` input
  // was never applied.
  //
  // This is a key outliving the data it indexes. The row-derived sequence was only ever correct
  // because nothing deleted rows — and a cron that deletes them was already in the repo.
  const engine = await ctx.db.get(engineId);
  const number = Math.max(prevInput?.number ?? -1, engine?.processedInputNumber ?? -1) + 1;
  const inputId = await ctx.db.insert('inputs', {
    engineId,
    number,
    name,
    args,
    received: now,
  });
  return inputId;
}

export const loadInputs = internalQuery({
  args: {
    engineId: v.id('engines'),
    processedInputNumber: v.optional(v.number()),
    max: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('inputs')
      .withIndex('byInputNumber', (q) =>
        q.eq('engineId', args.engineId).gt('number', args.processedInputNumber ?? -1),
      )
      .order('asc')
      .take(args.max);
  },
});

export async function applyEngineUpdate(
  ctx: MutationCtx,
  engineId: Id<'engines'>,
  update: EngineUpdate,
) {
  const engine = await loadEngine(ctx.db, engineId, update.expectedGenerationNumber);
  if (
    engine.currentTime &&
    update.engine.currentTime &&
    update.engine.currentTime < engine.currentTime
  ) {
    throw new Error('Time moving backwards');
  }
  await ctx.db.replace(engine._id, update.engine);

  for (const completedInput of update.completedInputs) {
    const input = await ctx.db.get(completedInput.inputId);
    if (!input) {
      throw new Error(`Input ${completedInput.inputId} not found`);
    }
    if (input.returnValue) {
      throw new Error(`Input ${completedInput.inputId} already completed`);
    }
    input.returnValue = completedInput.returnValue;
    await ctx.db.replace(input._id, input);
  }
}
