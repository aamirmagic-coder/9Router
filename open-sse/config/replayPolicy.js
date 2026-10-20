export const REPLAYABLE = "replayable";
export const NON_REPLAYABLE = "non-replayable";
export const REPLAY_POLICY_VALUES = Object.freeze([REPLAYABLE, NON_REPLAYABLE]);
export const DEFAULT_REPLAY_POLICY = REPLAYABLE;

export function normalizeReplayPolicy(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_REPLAY_POLICY;
  if (!REPLAY_POLICY_VALUES.includes(value)) {
    throw new Error(`replayPolicy must be one of: ${REPLAY_POLICY_VALUES.join(", ")}`);
  }
  return value;
}

export function readReplayPolicy(value) {
  try {
    return normalizeReplayPolicy(value);
  } catch {
    return DEFAULT_REPLAY_POLICY;
  }
}
