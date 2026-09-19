import { describe, expect, it } from "vitest";
import {
	DEFAULT_POOL_CEILING_RATIO,
	DEFAULT_POOL_CEILING_TOKENS,
	computeCeilingTokens,
	observationTokens,
	poolCeilingMetrics,
	selectCeilingEvictions,
} from "../src/agents/dropper/ceiling.js";
import type { Observation } from "../src/session-ledger/index.js";

function observation(overrides: Partial<Observation> & { id: string }): Observation {
	return {
		timestamp: "2026-09-19T00:00:00.000Z",
		relevance: "medium",
		content: "x".repeat(40),
		tokenCount: 10,
		...overrides,
	} as Observation;
}

describe("computeCeilingTokens", () => {
	const base = { fixedTokens: 30_000, ratio: 0.25, targetTokens: 10_000 };

	it("uses the fixed floor when the window is large", () => {
		expect(computeCeilingTokens({ ...base, contextWindow: 1_000_000 })).toBe(30_000);
	});

	it("scales down for a small window", () => {
		expect(computeCeilingTokens({ ...base, contextWindow: 80_000 })).toBe(20_000);
	});

	it("never falls below the dropper target", () => {
		expect(computeCeilingTokens({ ...base, contextWindow: 20_000 })).toBe(10_000);
	});

	it("falls back to the fixed floor without a usable window", () => {
		expect(computeCeilingTokens({ ...base })).toBe(30_000);
		expect(computeCeilingTokens({ ...base, contextWindow: 0 })).toBe(30_000);
	});

	it("falls back to the fixed floor without a usable ratio", () => {
		expect(computeCeilingTokens({ ...base, contextWindow: 100_000, ratio: 0 })).toBe(30_000);
		expect(computeCeilingTokens({ ...base, contextWindow: 100_000, ratio: Number.NaN })).toBe(30_000);
	});

	it("substitutes the default floor when the configured floor is unusable", () => {
		expect(computeCeilingTokens({ ...base, fixedTokens: 0, contextWindow: 1_000_000 })).toBe(DEFAULT_POOL_CEILING_TOKENS);
	});

	it("exposes a ratio default below 1", () => {
		expect(DEFAULT_POOL_CEILING_RATIO).toBeGreaterThan(0);
		expect(DEFAULT_POOL_CEILING_RATIO).toBeLessThan(1);
	});
});

describe("poolCeilingMetrics", () => {
	it("reports the overage", () => {
		const observations = [observation({ id: "a" }), observation({ id: "b" })];
		const metrics = poolCeilingMetrics(observations, 1);
		expect(metrics.overCeiling).toBe(true);
		expect(metrics.tokensOverCeiling).toBe(observationTokens(observations) - 1);
	});

	it("reports no overage at exactly the ceiling", () => {
		const observations = [observation({ id: "a" })];
		const metrics = poolCeilingMetrics(observations, observationTokens(observations));
		expect(metrics.overCeiling).toBe(false);
		expect(metrics.tokensOverCeiling).toBe(0);
	});
});

describe("selectCeilingEvictions", () => {
	it("evicts nothing when nothing needs freeing", () => {
		expect(selectCeilingEvictions([observation({ id: "a" })], 0)).toEqual([]);
		expect(selectCeilingEvictions([observation({ id: "a" })], -5)).toEqual([]);
	});

	it("prefers the lowest relevance first", () => {
		const observations = [
			observation({ id: "critical", relevance: "critical" }),
			observation({ id: "low", relevance: "low" }),
			observation({ id: "high", relevance: "high" }),
		];
		expect(selectCeilingEvictions(observations, 1)).toEqual(["low"]);
	});

	it("breaks ties by oldest first", () => {
		const observations = [
			observation({ id: "newer", relevance: "medium", timestamp: "2026-09-19T10:00:00.000Z" }),
			observation({ id: "older", relevance: "medium", timestamp: "2026-09-19T09:00:00.000Z" }),
		];
		expect(selectCeilingEvictions(observations, 1)).toEqual(["older"]);
	});

	it("stops once enough has been freed", () => {
		const observations = [
			observation({ id: "low", relevance: "low", content: "x".repeat(400) }),
			observation({ id: "medium", relevance: "medium", content: "x".repeat(400) }),
			observation({ id: "high", relevance: "high", content: "x".repeat(400) }),
		];
		// Calibrate against the real rendered-line estimate rather than guessing it.
		const perLine = observationTokens([observations[0]]);
		expect(selectCeilingEvictions(observations, perLine)).toEqual(["low"]);
		expect(selectCeilingEvictions(observations, perLine + 1)).toEqual(["low", "medium"]);
	});

	it("overshoots rather than returning nothing when one record is not enough", () => {
		const observations = [observation({ id: "critical", relevance: "critical" })];
		expect(selectCeilingEvictions(observations, 100_000)).toEqual(["critical"]);
	});

	it("is deterministic across orderings", () => {
		const a = observation({ id: "a", relevance: "low", timestamp: "2026-09-19T01:00:00.000Z" });
		const b = observation({ id: "b", relevance: "high", timestamp: "2026-09-19T02:00:00.000Z" });
		expect(selectCeilingEvictions([a, b], 1)).toEqual(selectCeilingEvictions([b, a], 1));
	});
});