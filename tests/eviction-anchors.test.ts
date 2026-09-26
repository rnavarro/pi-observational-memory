import { describe, expect, it } from "vitest";
import { extractAnchors, analyzeAnchorSurvival, missingAnchors } from "../src/agents/adjudicator/anchors.js";

describe("extractAnchors", () => {
	it("finds paths, hashes, versions, symbols, and constants", () => {
		const anchors = extractAnchors(
			"src/agents/adjudicator/agent.ts carries hashId plus DEFAULT_POOL_CEILING_TOKENS, and dd0bfd9abf678 landed in 3.1.3.",
		);
		expect(anchors).toContain("src/agents/adjudicator/agent.ts");
		expect(anchors).toContain("hashId");
		expect(anchors).toContain("DEFAULT_POOL_CEILING_TOKENS");
		expect(anchors).toContain("dd0bfd9abf678");
		expect(anchors).toContain("3.1.3");
	});

	it("does not mistake an ordinary a-f word for a commit hash", () => {
		// "deadhead" is spelled only from a-f; a hash must contain a digit.
		expect(extractAnchors("the deadhead faced a decade of beads")).toEqual([]);
	});

	it("does not mistake a hyphenated date or numeric range for a commit hash", () => {
		// All-digit runs such as these pass the digit requirement but carry no a-f
		// letter, so they are not hash-shaped.
		expect(extractAnchors("the 2026-09-20 fold and the 1908-1960 lines, rows 196-210")).toEqual([]);
	});

	it("still extracts hash-shaped and UUID-shaped runs", () => {
		expect(extractAnchors("dd0bfd9abf678 then 90f8c8c8-642d-4081 then a3c7e18")).toEqual([
			"dd0bfd9abf678",
			"90f8c8c8-642d-4081",
			"a3c7e18",
		]);
	});

	it("finds no anchors in prose without identifiers", () => {
		expect(extractAnchors("the user prefers shorter replies and plain language")).toEqual([]);
	});

	it("de-duplicates repeated anchors", () => {
		expect(extractAnchors("hashId then hashId then hashId")).toEqual(["hashId"]);
	});
});

describe("missingAnchors", () => {
	it("reports nothing when every anchor carried over", () => {
		expect(missingAnchors("fixed src/ids.ts with hashId", "fixed src/ids.ts using hashId")).toEqual([]);
	});

	it("reports an anchor the surviving text dropped", () => {
		expect(missingAnchors("added distributedReflectionIdForObservation to src/ids.ts", "added a map to src/ids.ts")).toEqual([
			"distributedReflectionIdForObservation",
		]);
	});

	it("treats a re-formatted identifier as missing, which is why it is only a diagnostic", () => {
		// The five live sub-60% cases were dominated by exactly this: a UUID or path
		// written differently rather than a fact that was lost.
		expect(missingAnchors("session 90f8c8c8-642d-4081", "session 90f8c8c8642d4081")).toEqual(["90f8c8c8-642d-4081"]);
	});
});

describe("analyzeAnchorSurvival", () => {
	it("reports extracted count, verbatim misses, and normalized misses separately", () => {
		const survival = analyzeAnchorSurvival("Fact about src/agents/anchors.ts", "Fact about agents/anchors.ts");
		expect(survival.extracted).toEqual(["src/agents/anchors.ts"]);
		expect(survival.missing).toEqual(["src/agents/anchors.ts"]);
		expect(survival.missingAfterNormalization).toEqual([]);
	});

	it("stops treating a re-hyphenated hex run as missing", () => {
		const survival = analyzeAnchorSurvival("commit 90f8c8c8-642d-4081 landed", "commit 90F8C8C8642D4081 landed");
		expect(survival.missing).toEqual(["90f8c8c8-642d-4081"]);
		expect(survival.missingAfterNormalization).toEqual([]);
	});

	it("keeps verbatim matching for a symbol, which has no reformatting form", () => {
		const survival = analyzeAnchorSurvival("uses selectReflectionBudget", "uses a helper");
		expect(survival.missingAfterNormalization).toEqual(["selectReflectionBudget"]);
	});

	it("does not let a basename shorter than eight characters satisfy a dropped path", () => {
		const survival = analyzeAnchorSurvival("wrote src/a/b.ts", "wrote the file");
		// "b.ts" is too short to be a safe basename match, so the loss stands.
		expect(survival.missingAfterNormalization).toEqual(["src/a/b.ts"]);
	});

	it("reports zero extracted anchors for prose, so the rate cannot speak to it", () => {
		const survival = analyzeAnchorSurvival("the user prefers plain language", "the user likes plain words");
		expect(survival.extracted).toEqual([]);
		expect(survival.missing).toEqual([]);
		expect(survival.missingAfterNormalization).toEqual([]);
	});
});

describe("missingAnchors sampling contract", () => {
	it("reports every missing anchor, leaving sampling to the caller", () => {
		// Sampling bounds how many candidates are logged; trimming one candidate's
		// result would make the logged case useless for diagnosis.
		expect(missingAnchors("a/b.ts c/d.ts e/f.ts", "nothing here")).toEqual(["a/b.ts", "c/d.ts", "e/f.ts"]);
	});
});
describe("known blind spots, pinned on purpose", () => {
	// These are the reasons the anchor check is a diagnostic and not a gate: it
	// cannot see the failures that matter most. See
	// tests/fixtures/adjudicator-challenge-cases.md. If a future change makes any
	// of these report an omission, the check has become stronger and the
	// diagnostic-only decision should be revisited.
	it("cannot see a dropped negation", () => {
		expect(missingAnchors("reflectionsForDropper is not yet exported from the ledger index", "reflectionsForDropper is exported from the ledger index")).toEqual([]);
	});

	it("cannot see a dropped pending qualifier", () => {
		expect(missingAnchors("Migration is designed but not yet applied", "Migration is applied")).toEqual([]);
	});

	it("cannot see a dropped approval", () => {
		expect(missingAnchors("User approved option A; do A", "User discussed option A")).toEqual([]);
	});
});
