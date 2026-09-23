import { beforeEach, describe, expect, it, vi } from "vitest";

import { observation, reflection } from "./fixtures/session.js";
import { hashId } from "../src/ids.js";

/**
 * Asserts the payload `runAdjudicator` actually emits, because the metrics are
 * only useful if the accumulation during tool execution reaches the log intact.
 * The debug log is captured rather than written.
 */
const logged: Array<{ event: string; data: any }> = [];

vi.mock("../src/debug-log.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		debugLog: (event: string, data?: unknown) => {
			logged.push({ event, data: data as any });
		},
	};
});

const { runAdjudicator } = await import("../src/agents/adjudicator/agent.js");

// Real content, because the anchor diagnostic reads it.
const A = "aaaaaaaaaaaa"; // high, no coverage, replaced by a reflection that lost its path
const B = "bbbbbbbbbbbb"; // critical, partially covered, distilled faithfully
const C = "cccccccccccc"; // low, retired with structured supersession evidence
const D = "dddddddddddd"; // medium, retired on its rationale alone
const REF = "eeeeeeeeeeee";

async function adjudicate(decisions: unknown[]) {
	const loop = ((_prompts: any[], context: any) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			await context.tools[0].execute("tool-1", { decisions });
			return {};
		},
	})) as any;
	return await runAdjudicator({
		apiKey: "test",
		model: { reasoning: false },
		candidates: [
			observation(A, { relevance: "high", content: "Fact about src/agents/anchors.ts", tokenCount: 10 }),
			observation(B, { relevance: "critical", content: "Knob MAX_RETRY_COUNT gates retries", tokenCount: 20 }),
			observation(C, { relevance: "low", content: "Transient progress note", tokenCount: 30 }),
			observation(D, { relevance: "medium", content: "Another transient note", tokenCount: 40 }),
		],
		reflections: [reflection(REF, [B], { content: "Knob MAX_RETRY_COUNT gates retries", tokenCount: 7 })],
		agentLoop: loop,
	} as any);
}

/** Same shape, for cases that need their own candidates and reflections. */
async function adjudicateWith(args: { candidates: any[]; reflections: any[]; decisions: unknown[] }) {
	const loop = ((_prompts: any[], context: any) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			await context.tools[0].execute("tool-1", { decisions: args.decisions });
			return {};
		},
	})) as any;
	return await runAdjudicator({
		apiKey: "test",
		model: { reasoning: false },
		candidates: args.candidates,
		reflections: args.reflections,
		agentLoop: loop,
	} as any);
}

const result = () => logged.find((entry) => entry.event === "adjudicator.result")?.data;
const start = () => logged.find((entry) => entry.event === "adjudicator.agent_start")?.data;

describe("adjudicator observability", () => {
	beforeEach(() => {
		logged.length = 0;
	});

	it("attributes anchor loss to the outcome that authored the surviving text", async () => {
		await adjudicate([
			// replace: the named reflection does not carry the observation's path
			{ id: A, outcome: "replace", replacementReflectionId: REF, rationale: "same fact" },
			// distill: faithful, keeps the constant
			{ id: B, outcome: "distill", distilledContent: "MAX_RETRY_COUNT gates retries", rationale: "durable knob" },
			{ id: C, outcome: "retire", supersededById: REF, rationale: "superseded" },
			{ id: D, outcome: "retire", rationale: "transient" },
		]);

		const data = result();
		expect(data.anchorReplace).toEqual({ checked: 1, clean: 0, lossy: 1, normalizedLossy: 1, unanchored: 0 });
		expect(data.anchorDistill).toEqual({ checked: 1, clean: 1, lossy: 0, normalizedLossy: 0, unanchored: 0 });
		expect(data.anchorLossyCount).toBe(1);
		expect(data.anchorNormalizedLossyCount).toBe(1);
		expect(data.anchorCleanCount).toBe(1);
		expect(data.anchorTallyScope).toBe("final_adjudicator_decisions");

		// The sample is attributable without inference, which is what the old
		// bare-anchor-strings sample could not do, and it carries the source's anchor
		// count so a single loss is read against its denominator.
		expect(data.anchorMissingSample).toEqual([
			{
				observationId: A,
				outcome: "replace",
				relevance: "high",
				coverage: "none",
				extractedCount: 1,
				missing: ["src/agents/anchors.ts"],
				missingAfterNormalization: ["src/agents/anchors.ts"],
			},
		]);
	});

	it("counts a reformatted anchor as present, so the artifact rate is measured", async () => {
		await adjudicateWith({
			candidates: [observation(A, { relevance: "high", content: "Fact about src/agents/anchors.ts", tokenCount: 10 })],
			reflections: [],
			decisions: [{ id: A, outcome: "distill", distilledContent: "Fact about agents/anchors.ts", rationale: "same fact" }],
		});
		const data = result();
		// Absent verbatim, present as its trailing segments: a reformatting, not an
		// omission, so it raises `lossy` but must not raise the normalized count.
		expect(data.anchorDistill).toEqual({ checked: 1, clean: 0, lossy: 1, normalizedLossy: 0, unanchored: 0 });
		expect(data.anchorNormalizedLossyCount).toBe(0);
		// Only a decision that survives normalization is worth sampling.
		expect(data.anchorMissingSample).toEqual([]);
	});

	it("attributes a distillation downgraded to replace to replace, not distill", async () => {
		const content = "Knob MAX_RETRY_COUNT gates retries";
		const refId = hashId(content);
		await adjudicateWith({
			candidates: [observation(A, { relevance: "high", content, tokenCount: 10 })],
			reflections: [reflection(refId, [A], { content, tokenCount: 7 })],
			decisions: [{ id: A, outcome: "distill", distilledContent: content, rationale: "already captured" }],
		});
		const data = result();
		// The batch commits this as replace; crediting distill would attribute loss to
		// an outcome that never authored the surviving text.
		expect(data.distillAlreadyReflectedCount).toBe(1);
		expect(data.anchorReplace.checked).toBe(1);
		expect(data.anchorDistill.checked).toBe(0);
	});

	it("does not credit a verdict a later contradiction collapses to keep", async () => {
		await adjudicateWith({
			candidates: [observation(A, { relevance: "high", content: "Fact about src/agents/anchors.ts", tokenCount: 10 })],
			reflections: [reflection(REF, [A], { content: "unrelated", tokenCount: 7 })],
			decisions: [
				{ id: A, outcome: "replace", replacementReflectionId: REF, rationale: "same fact" },
				{ id: A, outcome: "keep" },
			],
		});
		const data = result();
		expect(data.conflictingDecisionCount).toBe(1);
		expect(data.anchorCheckedCount).toBe(0);
		expect(data.anchorReplace).toEqual({ checked: 0, clean: 0, lossy: 0, normalizedLossy: 0, unanchored: 0 });
	});

	it("records the tier table and the retirement evidence mix", async () => {
		await adjudicate([
			{ id: A, outcome: "replace", replacementReflectionId: REF, rationale: "same fact" },
			{ id: B, outcome: "distill", distilledContent: "MAX_RETRY_COUNT gates retries", rationale: "durable knob" },
			{ id: C, outcome: "retire", supersededById: REF, rationale: "superseded" },
			{ id: D, outcome: "retire", rationale: "transient" },
		]);

		const data = result();
		expect(data.decisionsByTier).toEqual({
			"high/none": { keep: 0, retire: 0, replace: 1, distill: 0 },
			"critical/partial": { keep: 0, retire: 0, replace: 0, distill: 1 },
			"low/none": { keep: 0, retire: 1, replace: 0, distill: 0 },
			"medium/none": { keep: 0, retire: 1, replace: 0, distill: 0 },
		});
		expect(data.retireEvidencedCount).toBe(1);
		expect(data.retireBareCount).toBe(1);
		expect(data.retireWithoutRationaleCount).toBe(0);
		expect(data.observationTokensByOutcome).toEqual({ keep: 0, retire: 70, replace: 10, distill: 20 });
	});

	it("reports the rendered reflection payload, which no ceiling bounds", async () => {
		await adjudicate([{ id: B, outcome: "distill", distilledContent: "MAX_RETRY_COUNT gates retries", rationale: "durable" }]);
		const data = result();
		expect(data.existingReflectionCount).toBe(1);
		expect(data.existingReflectionTokens).toBe(7);
		expect(data.distilledReflectionTokens).toBeGreaterThan(0);
		expect(typeof data.durationMs).toBe("number");
	});

	it("emits an agent_start marker, so this stage's latency is not blamed on the dropper", async () => {
		await adjudicate([{ id: A, outcome: "keep" }]);
		expect(start()).toEqual({ candidateCount: 4, existingReflectionCount: 1, existingReflectionTokens: 7 });
	});
});