import { ObjectType } from 'convex/values';
import { playerInputs } from './player';
import { conversationInputs } from './conversation';
import { agentInputs } from './agentInputs';
import { lifeInputs } from './lifeInputs';

// It's easy to hit circular dependencies with these imports,
// so assert at module scope so we hit errors when analyzing.
if (
  playerInputs === undefined ||
  conversationInputs === undefined ||
  agentInputs === undefined ||
  lifeInputs === undefined
) {
  throw new Error("Input map is undefined, check if there's a circular import.");
}
export const inputs = {
  ...playerInputs,
  // Inputs for the messaging layer.
  ...conversationInputs,
  // Inputs for the agent layer.
  ...agentInputs,
  // Birth and death (v3.0). Deliberately NOT folded into playerInputs: `leave` is unsafe for any
  // player with an agent attached — it removes the player and leaves the agent orphaned, which
  // used to wedge the engine permanently. See lifeInputs.ts for the full mechanism.
  ...lifeInputs,
};
export type Inputs = typeof inputs;
export type InputNames = keyof Inputs;
export type InputArgs<Name extends InputNames> = ObjectType<Inputs[Name]['args']>;
export type InputReturnValue<Name extends InputNames> = ReturnType<
  Inputs[Name]['handler']
> extends Promise<infer T>
  ? T
  : never;
