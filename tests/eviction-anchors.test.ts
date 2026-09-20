import { describe, expect, it } from "vitest";
import { extractAnchors, missingAnchors, sampleMissingAnchors } from "../src/agents/adjudicator/anchors.js";

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

describe("sampleMissingAnchors", () => {
	it("caps the sample so the debug log stays bounded", () => {
		const source = "a/b.ts c/d.ts e/f.ts g/h.ts";
		expect(sampleMissingAnchors(source, "nothing here", 2)).toHaveLength(2);
	});

	it("returns nothing for a non-positive limit", () => {
		expect(sampleMissingAnchors("a/b.ts", "nothing", 0)).toEqual([]);
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
