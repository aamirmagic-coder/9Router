import { describe, it, expect } from "vitest";
import { getUsageStats, getChartData } from "@/lib/db/index.js";

describe("Usage 'all' period support", () => {
  it("getUsageStats('all') returns stats without error and covers historical data", async () => {
    const stats = await getUsageStats("all");
    expect(stats).toBeDefined();
    expect(stats.totalPromptTokens).toBeGreaterThan(0);
    expect(Object.keys(stats.byModel).length).toBeGreaterThan(0);
  });

  it("getChartData('all') returns timeline array covering all days", async () => {
    const chart = await getChartData("all");
    expect(Array.isArray(chart)).toBe(true);
    expect(chart.length).toBeGreaterThan(0);
    expect(chart[0]).toHaveProperty("label");
    expect(chart[0]).toHaveProperty("tokens");
    expect(chart[0]).toHaveProperty("cost");
  });
});
