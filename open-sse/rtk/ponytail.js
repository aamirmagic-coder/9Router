// Ponytail injector: appends the "lazy senior dev" instruction into the system
// message of the final request body, just before dispatch to the provider executor.
//
// The doctrine is authored upstream (https://github.com/DietrichGebert/ponytail) and
// revised often, while a gateway release is not. `override` lets a user pin their own
// text; an empty or blank override keeps the built-in prompts for the chosen level.

import { injectSystemPrompt } from "./systemInject.js";
import { PONYTAIL_PROMPTS } from "./ponytailPrompt.js";

export function resolvePonytailPrompt(level, override) {
  if (typeof override === "string" && override.trim()) return override;
  return PONYTAIL_PROMPTS[level];
}

export function injectPonytail(body, format, level, override) {
  const prompt = resolvePonytailPrompt(level, override);
  if (!prompt) return;
  injectSystemPrompt(body, format, prompt);
}
