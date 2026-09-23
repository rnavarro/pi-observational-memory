import { describe, expect, it } from "vitest";

import { runAdjudicator } from "../src/agents/adjudicator/agent.js";
import { hashId } from "../src/ids.js";
import { estimateStringTokens } from "../src/tokens.js";
import { observation, reflection } from "./fixtures/session.js";

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const REF = "eeeeeeeeeeee";

function baseArgs(overrides: Record<string, unknown> = {}) {
	return {
		apiKey: "test",
		model: { reasoning: true },
		candidates: [observation(A, { relevance: "high" }), observation(B, { relevance: "critical" })],
		reflections: [reflection(REF, [A])],
		...overrides,
	};
}

function decide(decisions: unknown[]): any {
	return fakeAgentLoop(async (_prompts, context) => {
		await context.tools[0].execute("tool-1", { decisions });
	});
}

describe("runAdjudicator fail-closed defaults", () => {
	it("returns undefined without candidates", async () => {
		await expect(runAdjudicator(baseArgs({ candidates: [] }) as any)).resolves.toBeUndefined();
	});

	it("keeps every candidate when the model never calls the tool", async () => {
		const result = await runAdjudicator(baseArgs({ agentLoop: fakeAgentLoop(() => {}) }) as any);
		expect(result?.decisions.map((d) => d.outcome)).toEqual(["keep", "keep"]);
		expect(result?.keptIds).toEqual([A, B]);
	});

	it("keeps a candidate the model left out", async () => {
		const result = await runAdjudicator(baseArgs({ agentLoop: decide([{ id: A, outcome: "retire" }]) }) as any);
		expect(result?.retiredIds).toEqual([A]);
		expect(result?.keptIds).toEqual([B]);
		expect(result?.decisions).toHaveLength(2);
		expect(result?.decisions[1]).toEqual({ id: B, outcome: "keep", rationale: "no decision returned; kept by default" });
	});

	it("emits exactly one decision per candidate in candidate order", async () => {
		const result = await runAdjudicator(baseArgs({ agentLoop: decide([{ id: B, outcome: "retire" }, { id: A, outcome: "keep" }]) }) as any);
		expect(result?.decisions.map((d) => d.id)).toEqual([A, B]);
	});

	it("ignores ids that are not candidates", async () => {
		const result = await runAdjudicator(baseArgs({ agentLoop: decide([{ id: "nope", outcome: "retire" }]) }) as any);
		expect(result?.decisions.map((d) => d.outcome)).toEqual(["keep", "keep"]);
	});

	it("keeps the first decision when a repeated id repeats the same outcome", async () => {
		const result = await runAdjudicator(
			baseArgs({ agentLoop: decide([{ id: A, outcome: "retire" }, { id: A, outcome: "retire" }]) }) as any,
		);
		expect(result?.decisions[0].outcome).toBe("retire");
	});

	it("collapses a conflicting repeated id to keep", async () => {
		// A contradictory verdict must not resolve destructive: the later `keep`
		// cannot be discarded, and the earlier `retire` must not win.
		const result = await runAdjudicator(
			baseArgs({ agentLoop: decide([{ id: A, outcome: "retire" }, { id: A, outcome: "keep" }]) }) as any,
		);
		expect(result?.decisions[0].outcome).toBe("keep");
		expect(result?.keptIds).toContain(A);
		expect(result?.retiredIds).toEqual([]);
	});

	it("collapses a conflicting repeated id to keep regardless of order", async () => {
		const result = await runAdjudicator(
			baseArgs({ agentLoop: decide([{ id: A, outcome: "keep" }, { id: A, outcome: "distill", distilledContent: "x" }]) }) as any,
		);
		expect(result?.decisions[0].outcome).toBe("keep");
		expect(result?.distilled).toEqual([]);
	});
});

describe("runAdjudicator replace", () => {
	it("accepts a replace naming a listed reflection", async () => {
		const result = await runAdjudicator(
			baseArgs({ agentLoop: decide([{ id: A, outcome: "replace", replacementReflectionId: REF }]) }) as any,
		);
		expect(result?.replacedIds).toEqual([A]);
		expect(result?.decisions[0].replacementReflectionId).toBe(REF);
	});

	it("keeps a candidate whose replacement reflection does not exist", async () => {
		const result = await runAdjudicator(
			baseArgs({ agentLoop: decide([{ id: A, outcome: "replace", replacementReflectionId: "ffffffffffff" }]) }) as any,
		);
		expect(result?.replacedIds).toEqual([]);
		expect(result?.keptIds).toContain(A);
	});

	it("keeps a candidate whose replace omits the reflection id", async () => {
		const result = await runAdjudicator(baseArgs({ agentLoop: decide([{ id: A, outcome: "replace" }]) }) as any);
		expect(result?.keptIds).toContain(A);
	});
});

describe("runAdjudicator distill", () => {
	it("builds a reflection from distilled content", async () => {
		const content = "User prefers tabs over spaces in this repo";
		const result = await runAdjudicator(
			baseArgs({ agentLoop: decide([{ id: A, outcome: "distill", distilledContent: content }]) }) as any,
		);
		expect(result?.distilledIds).toEqual([A]);
		expect(result?.distilled).toEqual([
			{ id: hashId(content), content, supportingObservationIds: [A], tokenCount: estimateStringTokens(content) },
		]);
	});

	it("keeps a candidate whose distilled content is missing or blank", async () => {
		const result = await runAdjudicator(
			baseArgs({ agentLoop: decide([{ id: A, outcome: "distill" }, { id: B, outcome: "distill", distilledContent: "   " }]) }) as any,
		);
		expect(result?.distilled).toEqual([]);
		expect(result?.keptIds).toEqual([A, B]);
	});

	it("keeps a candidate whose distilled content spans lines", async () => {
		const result = await runAdjudicator(
			baseArgs({ agentLoop: decide([{ id: A, outcome: "distill", distilledContent: "first line\nsecond line" }]) }) as any,
		);
		expect(result?.distilled).toEqual([]);
		expect(result?.keptIds).toContain(A);
	});

	it("downgrades a distillation identical to an existing reflection into a replace", async () => {
		// The reflector names a reflection by the hash of its content, so a
		// byte-identical distillation hashes to an id that already exists.
		const content = "Existing reflection content";
		const existing = { id: hashId(content), content, supportingObservationIds: [A], tokenCount: estimateStringTokens(content) };
		const result = await runAdjudicator(
			baseArgs({
				reflections: [existing],
				agentLoop: decide([{ id: A, outcome: "distill", distilledContent: content }]),
			}) as any,
		);
		expect(result?.distilled).toEqual([]);
		expect(result?.replacedIds).toEqual([A]);
		expect(result?.decisions[0]).toEqual({
			id: A,
			outcome: "replace",
			replacementReflectionId: hashId(content),
			rationale: undefined,
		});
	});

	it("keeps a candidate whose distilled content exceeds the record limit", async () => {
		// Truncating would authorise an irreversible drop against a representation
		// that may have discarded the load-bearing detail, so oversized content is
		// rejected outright and the observation is kept.
		const content = "y".repeat(10_001);
		const result = await runAdjudicator(
			baseArgs({ agentLoop: decide([{ id: A, outcome: "distill", distilledContent: content }]) }) as any,
		);
		expect(result?.distilled).toEqual([]);
		expect(result?.distilledIds).toEqual([]);
		expect(result?.keptIds).toContain(A);
	});

	it("downgrades a distillation whose reflection id equals the observation id", async () => {
		// Both namespaces name records by content hash, so an observation already
		// preserved verbatim as a reflection shares that reflection's id. Saying so
		// is a legitimate replace, not a vacuous self-reference.
		const content = "Kagi search is the primary research tool";
		const sameId = hashId(content);
		const result = await runAdjudicator(
			baseArgs({
				candidates: [observation(sameId, { relevance: "high" })],
				reflections: [reflection(sameId, [sameId])],
				agentLoop: decide([{ id: sameId, outcome: "distill", distilledContent: content }]),
			}) as any,
		);
		expect(result?.distilled).toEqual([]);
		expect(result?.replacedIds).toEqual([sameId]);
		expect(result?.decisions[0]).toEqual({
			id: sameId,
			outcome: "replace",
			replacementReflectionId: sameId,
			rationale: undefined,
		});
	});

	it("merges same-run duplicate distillations into one reflection with both support ids", async () => {
		const content = "Deploys run from the main checkout, never a worktree";
		const result = await runAdjudicator(
			baseArgs({
				agentLoop: decide([
					{ id: A, outcome: "distill", distilledContent: content },
					{ id: B, outcome: "distill", distilledContent: content },
				]),
			}) as any,
		);
		expect(result?.distilled).toHaveLength(1);
		expect(result?.distilled[0].supportingObservationIds).toEqual([A, B]);
		expect(result?.distilledIds).toEqual([A, B]);
	});
});

describe("runAdjudicator loop config", () => {
	it("passes the configured turn cap and honours the thinking level", async () => {
		let loopConfig: any;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			loopConfig = config;
		});
		await runAdjudicator(baseArgs({ agentLoop: loop, maxTurns: 3, thinkingLevel: "high", model: { reasoning: true } as any }) as any);
		expect(loopConfig.reasoning).toBe("high");
		expect(loopConfig.shouldStopAfterTurn).toBeTypeOf("function");
	});

	it("omits the turn cap when it is unset or non-positive", async () => {
		let loopConfig: any;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			loopConfig = config;
		});
		await runAdjudicator(baseArgs({ agentLoop: loop, maxTurns: 0 }) as any);
		expect(loopConfig.shouldStopAfterTurn).toBeUndefined();
	});
});
describe("runAdjudicator structured supersession", () => {
	it("carries supersededById through on a retire that names a known reflection", async () => {
		const result = await runAdjudicator(
			baseArgs({ agentLoop: decide([{ id: A, outcome: "retire", rationale: "superseded", supersededById: REF }]) }) as any,
		);
		const decision = result?.decisions.find((d) => d.id === A);
		expect(decision?.outcome).toBe("retire");
		expect(decision?.supersededById).toBe(REF);
	});

	it("keeps the candidate when the supersession claim names an unknown reflection", async () => {
		const result = await runAdjudicator(
			baseArgs({ agentLoop: decide([{ id: A, outcome: "retire", rationale: "superseded", supersededById: B }]) }) as any,
		);
		const decision = result?.decisions.find((d) => d.id === A);
		expect(decision?.outcome).toBe("keep");
		expect(result?.retiredIds).toEqual([]);
	});

	it("omits supersededById on a plain retire", async () => {
		const result = await runAdjudicator(baseArgs({ agentLoop: decide([{ id: A, outcome: "retire", rationale: "routine ack" }]) }) as any);
		expect(result?.decisions.find((d) => d.id === A)).toEqual({ id: A, outcome: "retire", rationale: "routine ack" });
	});

	it("does not confuse a supersession claim with an equivalence claim", async () => {
		// replace names a surviving representation; supersededById only records that
		// a newer record made this one obsolete. They are distinct outcomes.
		const result = await runAdjudicator(
			baseArgs({ agentLoop: decide([{ id: A, outcome: "replace", replacementReflectionId: REF, rationale: "equivalent" }]) }) as any,
		);
		expect(result?.decisions.find((d) => d.id === A)?.outcome).toBe("replace");
		expect(result?.decisions.find((d) => d.id === A)?.supersededById).toBeUndefined();
	});
});
