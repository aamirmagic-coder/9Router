import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { MODEL_SYNONYMS, MODEL_PATTERNS } = require("../../src/mitm/config.js");

// Reproduces getMappedModel() from src/mitm/server.js against an in-memory alias table,
// so the matching order (synonym → exact → prefix → pattern → wildcard) is covered without
// booting the MITM server.
const SEPARATORS = ["-", "_", ":", "/", "."];
const isBoundary = (shorter, longer) =>
  longer.length > shorter.length && SEPARATORS.includes(longer[shorter.length]);

function getMappedModel(tool, model, aliases) {
  if (!model) return null;
  try {
    if (!aliases) return null;
    const normalizedModel = String(model).replace(/^models\//, "");
    const lookup = MODEL_SYNONYMS?.[tool]?.[normalizedModel] || normalizedModel;
    if (aliases[lookup]) return aliases[lookup];
    const prefixKey = Object.keys(aliases).find(
      (k) => k && aliases[k] && (isBoundary(k, lookup) || isBoundary(lookup, k))
    );
    if (prefixKey) return aliases[prefixKey];
    const patterns = MODEL_PATTERNS?.[tool] || [];
    for (const { match, alias } of patterns) {
      if (match.test(lookup) && aliases[alias]) return aliases[alias];
    }
    if (aliases["*"]) return aliases["*"];
    return null;
  } catch {
    return null;
  }
}

describe("Kiro MITM model mapping", () => {
  const table = {
    "qwen3-coder-next": "alibaba/qwen3-coder-next",
    "simple-task": "alibaba/qwen3-coder-flash",
    auto: "ag/gemini-3.8-flash",
    "gpt-5.6-sol": "ag/gemini-3.8-flash-high",
  };

  it("maps the editor model id 'qwen3-coder-next' to its own slot", () => {
    expect(getMappedModel("kiro", "qwen3-coder-next", table)).toBe("alibaba/qwen3-coder-next");
  });

  it("maps the background model id 'simple-task' to the background slot", () => {
    expect(getMappedModel("kiro", "simple-task", table)).toBe("alibaba/qwen3-coder-flash");
  });

  it("does not let 'simple-task' steal the editor model", () => {
    // Regression: the two ids used to share one slot, so a dashboard save under
    // "simple-task" was looked up for "qwen3-coder-next" and missed → AWS passthrough.
    expect(getMappedModel("kiro", "qwen3-coder-next", table)).not.toBe(
      getMappedModel("kiro", "simple-task", table)
    );
  });

  it("strips a models/ prefix", () => {
    expect(getMappedModel("kiro", "models/qwen3-coder-next", table)).toBe("alibaba/qwen3-coder-next");
  });

  it("normalizes qwen coder variants through synonyms", () => {
    for (const id of ["qwen3-coder", "qwen-3-coder-next", "qwen3coder-next", "qwen3-coder-next-1"]) {
      expect(getMappedModel("kiro", id, table)).toBe("alibaba/qwen3-coder-next");
    }
  });

  it("falls back to pattern matching for unseen qwen coder ids", () => {
    expect(getMappedModel("kiro", "qwen3-coder-next-preview-v2", table)).toBe(
      "alibaba/qwen3-coder-next"
    );
  });

  it("falls back to pattern matching for unseen simple-task ids", () => {
    expect(getMappedModel("kiro", "simple-task-v2", table)).toBe("alibaba/qwen3-coder-flash");
  });

  it("does not match a short key across a non-separator boundary", () => {
    // "auto" must not swallow "autocomplete-model"
    const aliases = { auto: "ag/flash", "autocomplete-model": "ag/tab" };
    expect(getMappedModel("kiro", "autocomplete-model-x", aliases)).toBe("ag/tab");
  });

  it("returns null when nothing matches and there is no wildcard", () => {
    expect(getMappedModel("kiro", "totally-unknown-model", table)).toBeNull();
  });

  it("uses the wildcard entry when present", () => {
    expect(getMappedModel("kiro", "totally-unknown-model", { ...table, "*": "fallback/model" })).toBe(
      "fallback/model"
    );
  });
});
