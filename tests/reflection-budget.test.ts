import { describe, expect, it } from "vitest";

import {
	computeReflectionsBudgetTokens,
	DEFAULT_REFLECTIONS_BUDGET_RATIO,
	DEFAULT_REFLECTIONS_BUDGET_TOKENS,
	DEFAULT_REFLECTIONS_INDEX_TOKENS,
	isReflectionRenderDetails,
	REFLECTION_INDEX_PREVIEW_CHARS,
	selectReflectionBudget,
} from "../src/session-ledger/index.js";
import { reflection } from "./fixtures/session.js";

/** A reflection whose rendered line is exactly 104 tokens: 15 chars of id prefix + 400. */
function sized(id: string, contentChars = 400) {
	return reflection(id, [], { content: "x".repeat(contentChars) });
}

const IDS = [
	"aaaaaaaaaaaa",
	"bbbbbbbbbbbb",
	"cccccccccccc",
	"dddddddddddd",
	"eeeeeeeeeeee",
] as const;

describe("reflection budget resolution", () => {
	it("uses the fixed budget when no context window is known", () => {
		expect(computeReflectionsBudgetTokens({ fixedTokens: 20_000, ratio: 0.1 })).toBe(20_000);
	});

	it("caps the fixed budget by the ratio of a small window", () => {
		expect(computeReflectionsBudgetTokens({ contextWindow: 100_000, fixedTokens: 20_000, ratio: 0.1 })).toBe(10_000);
	});

	it("keeps the fixed budget when the ratio would allow more", () => {
		expect(computeReflectionsBudgetTokens({ contextWindow: 1_000_000, fixedTokens: 20_000, ratio: 0.1 })).toBe(20_000);
	});

	it("falls back to the defaults for invalid knobs", () => {
		expect(computeReflectionsBudgetTokens({ contextWindow: 100_000, fixedTokens: -1, ratio: 0 })).toBe(
			DEFAULT_REFLECTIONS_BUDGET_TOKENS,
		);
		expect(computeReflectionsBudgetTokens({ contextWindow: Number.NaN, fixedTokens: 5_000, ratio: 0.1 })).toBe(5_000);
	});

	it("exposes defaults that bound the reflected payload", () => {
		expect(DEFAULT_REFLECTIONS_BUDGET_TOKENS).toBe(20_000);
		expect(DEFAULT_REFLECTIONS_INDEX_TOKENS).toBe(5_000);
		expect(DEFAULT_REFLECTIONS_BUDGET_RATIO).toBe(0.1);
	});
});

describe("reflection render metadata", () => {
	const valid = {
		policyVersion: 1,
		eligibleCount: 3,
		index: [{ id: "bbbbbbbbbbbb", preview: "a preview" }],
		omittedCount: 1,
		fullTokens: 104,
		indexTokens: 27,
		fullBudgetTokens: 104,
		indexBudgetTokens: 30,
	};

	it("accepts a well-formed record", () => {
		expect(isReflectionRenderDetails(valid)).toBe(true);
	});

	it("rejects a malformed record rather than trusting it", () => {
		expect(isReflectionRenderDetails(undefined)).toBe(false);
		expect(isReflectionRenderDetails({ ...valid, policyVersion: 2 })).toBe(false);
		expect(isReflectionRenderDetails({ ...valid, omittedCount: -1 })).toBe(false);
		expect(isReflectionRenderDetails({ ...valid, eligibleCount: "3" })).toBe(false);
		expect(isReflectionRenderDetails({ ...valid, index: [{ id: "not-an-id", preview: "x" }] })).toBe(false);
		expect(isReflectionRenderDetails({ ...valid, index: [{ id: "bbbbbbbbbbbb", preview: 5 }] })).toBe(false);
	});

	it("accepts the index tier in id form and rejects malformed ids", () => {
		const idForm = { ...valid, index: [], indexIds: ["bbbbbbbbbbbb"] };

		expect(isReflectionRenderDetails(idForm)).toBe(true);
		expect(isReflectionRenderDetails({ ...idForm, indexIds: [] })).toBe(true);
		expect(isReflectionRenderDetails({ ...idForm, indexIds: ["not-an-id"] })).toBe(false);
		expect(isReflectionRenderDetails({ ...idForm, indexIds: "bbbbbbbbbbbb" })).toBe(false);
		expect(isReflectionRenderDetails({ ...idForm, previewChars: 90 })).toBe(true);
		expect(isReflectionRenderDetails({ ...idForm, previewChars: 0 })).toBe(true);
		expect(isReflectionRenderDetails({ ...idForm, previewChars: -1 })).toBe(false);
		expect(isReflectionRenderDetails({ ...idForm, previewChars: "90" })).toBe(false);
	});
});

describe("reflection budget selection", () => {
	it("renders every reflection in full while under budget", () => {
		const reflections = IDS.slice(0, 3).map((id) => sized(id));
		const selection = selectReflectionBudget(reflections, { budgetTokens: 10_000, indexTokens: 5_000 });

		expect(selection.rendered.map((r) => r.id)).toEqual(IDS.slice(0, 3));
		expect(selection.indexed).toEqual([]);
		expect(selection.omittedCount).toBe(0);
		expect(selection.renderedTokens).toBeLessThanOrEqual(10_000);
	});

	it("renders the newest reflections when only part of the list fits", () => {
		const reflections = IDS.slice(0, 4).map((id) => sized(id));
		// Each line is 104 tokens, so a 250-token budget fits exactly two.
		const selection = selectReflectionBudget(reflections, { budgetTokens: 250, indexTokens: 5_000 });

		expect(selection.rendered.map((r) => r.id)).toEqual(["cccccccccccc", "dddddddddddd"]);
		// Ledger order is restored in the output so the summary reads chronologically.
		expect(selection.renderedTokens).toBeLessThanOrEqual(250);
		expect(selection.indexed.map((e) => e.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(selection.omittedCount).toBe(0);
	});

	it("indexes the survivors and omits the oldest when the index budget runs out", () => {
		const reflections = IDS.map((id) => sized(id));
		// One full line (104), one index line (27 at the default preview length).
		const selection = selectReflectionBudget(reflections, { budgetTokens: 104, indexTokens: 30 });

		expect(selection.rendered.map((r) => r.id)).toEqual(["eeeeeeeeeeee"]);
		expect(selection.indexed.map((e) => e.id)).toEqual(["dddddddddddd"]);
		// The records that lose their slot are the oldest, never the newest.
		expect(selection.omittedCount).toBe(3);
	});

	it("keeps protected reflections ahead of newer unprotected ones", () => {
		const reflections = IDS.slice(0, 4).map((id) => sized(id));
		const selection = selectReflectionBudget(reflections, {
			budgetTokens: 104,
			indexTokens: 5_000,
			protectedIds: new Set(["aaaaaaaaaaaa"]),
		});

		expect(selection.rendered.map((r) => r.id)).toEqual(["aaaaaaaaaaaa"]);
	});

	it("renders index previews on a single collapsed line", () => {
		const multiLine = reflection("aaaaaaaaaaaa", [], {
			content: `first line\n\nsecond line ${"y".repeat(400)}`,
		});
		const selection = selectReflectionBudget([multiLine], { budgetTokens: 1, indexTokens: 5_000 });

		expect(selection.indexed).toHaveLength(1);
		const preview = selection.indexed[0]?.preview ?? "";
		expect(preview).not.toContain("\n");
		expect(preview.endsWith("...")).toBe(true);
		expect(preview.length).toBeLessThanOrEqual(REFLECTION_INDEX_PREVIEW_CHARS + 3);
	});

	it("indexes everything when not even one line fits the full budget", () => {
		const reflections = IDS.slice(0, 2).map((id) => sized(id));
		const selection = selectReflectionBudget(reflections, { budgetTokens: 10, indexTokens: 5_000 });

		expect(selection.rendered).toEqual([]);
		expect(selection.renderedTokens).toBe(0);
		expect(selection.indexed.map((e) => e.id)).toEqual(IDS.slice(0, 2));
	});

	it("returns an empty selection for no reflections", () => {
		expect(selectReflectionBudget([], { budgetTokens: 100, indexTokens: 100 })).toEqual({
			rendered: [],
			indexed: [],
			omittedCount: 0,
			previewChars: 90,
			renderedTokens: 0,
			indexedTokens: 0,
		});
	});

	it("never exceeds the full-text budget", () => {
		const reflections = Array.from({ length: 40 }, (_, i) =>
			sized(`${i.toString(16).padStart(12, "0")}`, 100 + i * 37),
		);
		for (const budgetTokens of [1, 50, 104, 999, 4_000, 20_000]) {
			const selection = selectReflectionBudget(reflections, { budgetTokens, indexTokens: 2_000 });
			expect(selection.renderedTokens).toBeLessThanOrEqual(budgetTokens);
			expect(selection.indexedTokens).toBeLessThanOrEqual(2_000);
			expect(selection.rendered.length + selection.indexed.length + selection.omittedCount).toBe(reflections.length);
		}
	});
});