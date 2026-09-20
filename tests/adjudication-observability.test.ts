import { beforeEach, describe, expect, it, vi } from "vitest";

import { observation, reflection } from "./fixtures/session.js";

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
		expect(data.anchorReplace).toEqual({ checked: 1, clean: 0, lossy: 1, unanchored: 0 });
		expect(data.anchorDistill).toEqual({ checked: 1, clean: 1, lossy: 0, unanchored: 0 });
		expect(data.anchorLossyCount).toBe(1);
		expect(data.anchorCleanCount).toBe(1);

		// The sample is attributable without inference, which is what the old
		// bare-anchor-strings sample could not do.
		expect(data.anchorMissingSample).toEqual([
			{
				observationId: A,
				outcome: "replace",
				relevance: "high",
				coverage: "none",
				missing: ["src/agents/anchors.ts"],
			},
		]);
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