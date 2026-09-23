import { describe, expect, it } from "vitest";

import { buildAdjudicationMetrics, classifyUnknownSupersessionId, createAnchorTallies } from "../src/agents/adjudicator/metrics.js";
import { observation, reflection } from "./fixtures/session.js";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const REF = "eeeeeeeeeeee";

function input(overrides: Record<string, unknown> = {}) {
	return {
		candidates: [observation(A, { relevance: "high", tokenCount: 10 }), observation(B, { relevance: "critical", tokenCount: 20 })],
		coverageById: new Map([
			[A, "none" as const],
			[B, "partial" as const],
		]),
		decisions: [
			{ id: A, outcome: "retire" as const, supersededById: REF, rationale: "superseded" },
			{ id: B, outcome: "retire" as const, rationale: "transient" },
		],
		reflections: [reflection(REF, [B], { tokenCount: 7 })],
		distilledReflections: [],
		anchorByOutcome: createAnchorTallies(),
		anchorMissingSample: [],
		durationMs: 1234,
		...overrides,
	};
}

describe("buildAdjudicationMetrics", () => {
	it("crosses relevance with coverage and outcome", () => {
		const metrics = buildAdjudicationMetrics(input() as any);
		expect(metrics.decisionsByTier).toEqual({
			"high/none": { keep: 0, retire: 1, replace: 0, distill: 0 },
			"critical/partial": { keep: 0, retire: 1, replace: 0, distill: 0 },
		});
	});

	it("accumulates outcome counts across candidates in the same tier", () => {
		const metrics = buildAdjudicationMetrics(
			input({
				candidates: [observation(A, { relevance: "high", tokenCount: 10 }), observation(B, { relevance: "high", tokenCount: 20 })],
				coverageById: new Map([
					[A, "none" as const],
					[B, "none" as const],
				]),
				decisions: [
					{ id: A, outcome: "keep" as const },
					{ id: B, outcome: "distill" as const },
				],
			}) as any,
		);
		expect(metrics.decisionsByTier).toEqual({ "high/none": { keep: 1, retire: 0, replace: 0, distill: 1 } });
	});

	it("sums observation tokens by outcome, so pool shrink is readable", () => {
		const metrics = buildAdjudicationMetrics(
			input({
				decisions: [
					{ id: A, outcome: "retire" as const, rationale: "x" },
					{ id: B, outcome: "keep" as const },
				],
			}) as any,
		);
		expect(metrics.observationTokensByOutcome).toEqual({ keep: 20, retire: 10, replace: 0, distill: 0 });
	});

	it("separates evidenced retirements from bare ones", () => {
		const metrics = buildAdjudicationMetrics(input() as any);
		expect(metrics.retireEvidencedCount).toBe(1);
		expect(metrics.retireBareCount).toBe(1);
		expect(metrics.retireWithoutRationaleCount).toBe(0);
	});

	it("counts a retire with no rationale, which the strict writer refuses", () => {
		const metrics = buildAdjudicationMetrics(
			input({ decisions: [{ id: A, outcome: "retire" as const }, { id: B, outcome: "retire" as const, rationale: "   " }] }) as any,
		);
		expect(metrics.retireWithoutRationaleCount).toBe(2);
	});

	it("totals anchor survival across both authoring outcomes but keeps the split", () => {
		const anchorByOutcome = createAnchorTallies();
		anchorByOutcome.replace = { checked: 3, clean: 1, lossy: 2, unanchored: 1 };
		anchorByOutcome.distill = { checked: 4, clean: 4, lossy: 0, unanchored: 0 };
		const metrics = buildAdjudicationMetrics(input({ anchorByOutcome }) as any);
		expect(metrics.anchorCheckedCount).toBe(7);
		expect(metrics.anchorCleanCount).toBe(5);
		expect(metrics.anchorLossyCount).toBe(2);
		expect(metrics.anchorUnanchoredCount).toBe(1);
		expect(metrics.anchorReplace.lossy).toBe(2);
		expect(metrics.anchorDistill.lossy).toBe(0);
	});

	it("reports reflection payload size, which no ceiling bounds", () => {
		const metrics = buildAdjudicationMetrics(
			input({
				reflections: [reflection(REF, [B], { tokenCount: 7 }), reflection("ffffffffffff", [A], { tokenCount: 5 })],
				distilledReflections: [reflection("dddddddddddd", [A], { tokenCount: 3 })],
			}) as any,
		);
		expect(metrics.existingReflectionCount).toBe(2);
		expect(metrics.existingReflectionTokens).toBe(12);
		expect(metrics.distilledReflectionTokens).toBe(3);
	});

	it("ignores candidates that have no decision rather than inventing a tier row", () => {
		const metrics = buildAdjudicationMetrics(input({ decisions: [{ id: A, outcome: "retire" as const, rationale: "x" }] }) as any);
		expect(Object.keys(metrics.decisionsByTier)).toEqual(["high/none"]);
	});

	it("passes duration through and defaults an empty batch to zeroes", () => {
		const metrics = buildAdjudicationMetrics(input({ candidates: [], decisions: [], reflections: [] }) as any);
		expect(metrics.durationMs).toBe(1234);
		expect(metrics.decisionsByTier).toEqual({});
		expect(metrics.observationTokensByOutcome).toEqual({ keep: 0, retire: 0, replace: 0, distill: 0 });
		expect(metrics.existingReflectionTokens).toBe(0);
	});
});

describe("classifyUnknownSupersessionId", () => {
	const candidates = new Map([[A, "obs"]]);
	const distilled = new Map([[B, "refl"]]);

	it("names a candidate observation, so the prompt was entitled to the id", () => {
		expect(classifyUnknownSupersessionId(A, candidates, distilled)).toEqual({ length: 12, hex: true, target: "candidate_observation" });
	});

	it("names a reflection distilled earlier in the same run", () => {
		expect(classifyUnknownSupersessionId(B, candidates, distilled).target).toBe("same_run_distillation");
	});

	it("names nothing this run holds, so no validator widening would help", () => {
		expect(classifyUnknownSupersessionId("ffffffffffff", candidates, distilled).target).toBe("unnamed");
	});

	it("reports a short hex id without inventing a target", () => {
		const shape = classifyUnknownSupersessionId("f447e28", candidates, distilled);
		expect(shape).toEqual({ length: 7, hex: true, target: "unnamed" });
	});
});
