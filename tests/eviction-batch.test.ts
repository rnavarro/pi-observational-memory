import { describe, expect, it } from "vitest";
import { planEvictionBatch } from "../src/hooks/eviction-batch.js";
import type { Observation, Reflection } from "../src/session-ledger/index.js";
import type { AdjudicationDecision } from "../src/agents/adjudicator/agent.js";

function observation(id: string, overrides: Partial<Observation> = {}): Observation {
	return {
		id,
		timestamp: "2026-09-19T00:00:00.000Z",
		relevance: "medium",
		content: "x".repeat(400),
		tokenCount: 100,
		...overrides,
	} as Observation;
}

function reflection(id: string, supporting: string[]): Reflection {
	return { id, content: `reflection ${id}`, supportingObservationIds: supporting, tokenCount: 5 };
}

function retire(id: string): AdjudicationDecision {
	return { id, outcome: "retire", rationale: "superseded" };
}

function keep(id: string): AdjudicationDecision {
	return { id, outcome: "keep" };
}

function plan(args: {
	candidates: Observation[];
	decisions: AdjudicationDecision[];
	distilled?: Reflection[];
	currentReflectionIds?: string[];
}) {
	return planEvictionBatch({
		candidates: args.candidates,
		decisions: args.decisions,
		distilled: args.distilled ?? [],
		currentReflectionIds: args.currentReflectionIds ?? [],
	});
}

describe("planEvictionBatch decision handling", () => {
	it("drops only what the adjudicator authorised", () => {
		const a = observation("a");
		const b = observation("b");
		const result = plan({ candidates: [a, b], decisions: [retire("a"), keep("b")] });
		expect(result.droppedIds).toEqual(["a"]);
		expect(result.keptIds).toEqual(["b"]);
	});

	it("keeps a candidate with no decision at all", () => {
		const a = observation("a");
		const b = observation("b");
		const result = plan({ candidates: [a, b], decisions: [retire("a")] });
		expect(result.droppedIds).toEqual(["a"]);
		expect(result.keptIds).toEqual(["b"]);
	});

	it("preserves dropper-proposed order in droppedIds and decisions", () => {
		const a = observation("a");
		const b = observation("b");
		const c = observation("c");
		const result = plan({ candidates: [c, a, b], decisions: [retire("a"), retire("b"), retire("c")] });
		expect(result.droppedIds).toEqual(["c", "a", "b"]);
		expect(result.decisions.map((decision) => decision.id)).toEqual(["c", "a", "b"]);
	});

	it("emits one decision per dropped id, so the strict writer has one for each", () => {
		const result = plan({ candidates: [observation("a")], decisions: [retire("a")] });
		expect(result.droppedIds).toEqual(["a"]);
		expect(result.decisions.map((d) => d.id)).toEqual(["a"]);
	});

	it("carries a replacement reflection id through", () => {
		const result = plan({
			candidates: [observation("a")],
			decisions: [{ id: "a", outcome: "replace", replacementReflectionId: "r1" }],
			currentReflectionIds: ["r1"],
		});
		expect(result.decisions[0]).toEqual({ id: "a", outcome: "replace", replacementReflectionId: "r1", rationale: undefined });
		expect(result.survivingReflectionIds).toEqual(["r1"]);
	});

	it("returns an empty plan when every candidate is kept", () => {
		const result = plan({ candidates: [observation("a")], decisions: [keep("a")] });
		expect(result.droppedIds).toEqual([]);
		expect(result.decisions).toEqual([]);
	});
});

describe("planEvictionBatch distillation", () => {
	it("carries distilled reflections and maps them to their observation", () => {
		const distilled = reflection("r-new", ["a"]);
		const result = plan({
			candidates: [observation("a")],
			decisions: [{ id: "a", outcome: "distill" }],
			distilled: [distilled],
		});
		expect(result.distilled).toEqual([distilled]);
		expect(result.distilledReflectionIdForObservation.get("a")).toBe("r-new");
		expect(result.survivingReflectionIds).toContain("r-new");
	});

	it("drops a distilled reflection whose observation is not being dropped", () => {
		const result = plan({
			candidates: [observation("a")],
			decisions: [keep("a")],
			distilled: [reflection("r-new", ["a"])],
		});
		expect(result.distilled).toEqual([]);
	});

	it("merges existing and distilled reflection ids into the survivor set", () => {
		const result = plan({
			candidates: [observation("a")],
			decisions: [{ id: "a", outcome: "distill" }],
			distilled: [reflection("r-new", ["a"])],
			currentReflectionIds: ["r-old"],
		});
		expect(result.survivingReflectionIds).toEqual(["r-old", "r-new"]);
	});
});

describe("planEvictionBatch persisted witnesses", () => {
	it("records the distillation witness id on the drop decision", () => {
		const a = observation("a");
		const distilledReflection = reflection("dddddddddddd", ["a"]);
		const built = plan({
			candidates: [a],
			decisions: [{ id: "a", outcome: "distill", rationale: "durable" }],
			distilled: [distilledReflection],
		});
		const decision = built.decisions.find((d) => d.id === "a");
		expect(decision?.outcome).toBe("distill");
		// Self-describing entry: an audit should not have to infer this pairing.
		expect(decision?.distilledReflectionId).toBe("dddddddddddd");
		expect(built.distilled).toEqual([distilledReflection]);
	});

	it("omits a witness for a distilled reflection that supports no committed drop", () => {
		const a = observation("a");
		const b = observation("b");
		const built = plan({
			candidates: [a, b],
			decisions: [{ id: "a", outcome: "distill", rationale: "durable" }],
			distilled: [reflection("dddddddddddd", ["b"])],
		});
		expect(built.distilled).toEqual([]);
		expect(built.decisions[0].distilledReflectionId).toBeUndefined();
	});

	it("carries supersededById through to the drop decision", () => {
		const a = observation("a");
		const built = plan({
			candidates: [a],
			decisions: [{ id: "a", outcome: "retire", rationale: "obsolete", supersededById: "eeeeeeeeeeee" }],
		});
		expect(built.decisions[0].supersededById).toBe("eeeeeeeeeeee");
	});
});
