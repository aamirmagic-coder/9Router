import { NON_REPLAYABLE, readReplayPolicy } from "../config/replayPolicy.js";

export const DISPATCH_PRE = "pre-dispatch";
export const DISPATCH_ATTEMPTED = "dispatch-attempted";
export const DISPATCH_COMPLETED = "completed";

export function createDispatchContext() {
  return { state: DISPATCH_PRE };
}

export function markDispatchAttempted(context) {
  if (context) context.state = DISPATCH_ATTEMPTED;
  return context;
}

export function markDispatchCompleted(context) {
  if (context) context.state = DISPATCH_COMPLETED;
  return context;
}

export function getDispatchState(context) {
  return context?.state || DISPATCH_PRE;
}

export function hasDispatchStarted(contextOrState) {
  const state = typeof contextOrState === "string"
    ? contextOrState
    : getDispatchState(contextOrState);
  return state !== DISPATCH_PRE;
}

export function canReplayRequest(replayPolicy, contextOrState) {
  return readReplayPolicy(replayPolicy) !== NON_REPLAYABLE || !hasDispatchStarted(contextOrState);
}
