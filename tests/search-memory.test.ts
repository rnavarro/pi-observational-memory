import { describe, expect, it } from "vitest";
import {
	MEMORY_SEARCH_DEFAULT_LIMIT,
	MEMORY_SEARCH_MAX_LIMIT,
	memorySearchTokens,
	searchMemory,
	type Entry,
} from "../src/session-ledger/index.js";
import {
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	rawMessage,
} from "./fixtures/session.js";

const REFLECTION_BUDGET = "aaaaaaaabbbb";
const REFLECTION_CEILING = "bbbbbbbbcccc";
const REFLECTION_ADJUDICATOR = "ccccccccdddd";
const OBSERVATION_ONE = "ddddddddeeee";
const OBSERVATION_TWO = "eeeeeeeeffff";

function ledger(): Entry[] {
	return [
		rawMessage("raw-1", "user turns"),
		observationsRecordedEntry("obs-1", {
			coversUpToId: "raw-1",
			observations: [
				observation(OBSERVATION_ONE, {
					content: "The adjudicator is a second model call that runs after the dropper proposes evictions",
					relevance: "high",
				}),
				observation(OBSERVATION_TWO, { content: "WS90 weather station reports through a GW2000B gateway", relevance: "low" }),
			],
		}),
		reflectionsRecordedEntry("ref-1", {
			coversUpToId: "raw-1",
			reflections: [
				reflection(REFLECTION_BUDGET, [OBSERVATION_ONE], {
					content: "Reflections are bounded by reflectionsBudgetTokens in src/session-ledger/reflection-budget.ts",
				}),
				reflection(REFLECTION_CEILING, [OBSERVATION_ONE], {
					content: "Observation pool eviction has a deterministic ceiling backstop at 30000 tokens",
				}),
				reflection(REFLECTION_ADJUDICATOR, [OBSERVATION_ONE], {
					content: "The adjudicator prefers distillation over keeping a durable record uncovered",
				}),
			],
		}),
		observationsDroppedEntry("drop-1", {
			observationIds: [OBSERVATION_TWO],
			coversUpToId: "raw-1",
			decisions: [{ id: OBSERVATION_TWO, outcome: "retire", rationale: "superseded by later weather findings" }],
		}),
	] as Entry[];
}

describe("memorySearchTokens", () => {
	it("keeps identifier-shaped terms whole and also splits them", () => {
		const tokens = memorySearchTokens("see src/session-ledger/reflection-budget.ts and hashId");
		expect(tokens).toContain("src/session-ledger/reflection-budget.ts");
		expect(tokens).toContain("reflection");
		expect(tokens).toContain("budget");
		expect(tokens).toContain("hashid");
	});

	it("drops single-character fragments", () => {
		expect(memorySearchTokens("a x of to")).toEqual(["of", "to"]);
	});
});

describe("searchMemory query mode", () => {
	it("finds a reflection by words from its content", () => {
		const result = searchMemory(ledger(), "reflection budget");

		expect(result.mode).toBe("query");
		expect(result.total).toBeGreaterThan(0);
		expect(result.hits[0].id).toBe(REFLECTION_BUDGET);
		expect(result.hits[0].kind).toBe("reflection");
		expect(result.hits[0].score).toBeGreaterThan(0);
		expect(result.hits[0].matchedTerms).toContain("budget");
	});

	it("finds a record by a path even though the query words are a paraphrase", () => {
		const result = searchMemory(ledger(), "session ledger budget");

		expect(result.hits[0].id).toBe(REFLECTION_BUDGET);
	});

	it("finds a record by its id", () => {
		const result = searchMemory(ledger(), REFLECTION_CEILING);

		expect(result.hits[0].id).toBe(REFLECTION_CEILING);
	});

	it("scopes to reflections or observations", () => {
		expect(searchMemory(ledger(), "adjudicator", { scope: "reflections" }).hits.every((hit) => hit.kind === "reflection")).toBe(true);
		const observations = searchMemory(ledger(), "adjudicator", { scope: "observations" });
		expect(observations.hits.map((hit) => hit.id)).toEqual([OBSERVATION_ONE]);
	});

	it("reports a dropped observation as dropped", () => {
		const result = searchMemory(ledger(), "GW2000B", { scope: "observations" });

		expect(result.hits.map((hit) => hit.id)).toEqual([OBSERVATION_TWO]);
		expect(result.hits[0].dropped).toBe(true);
	});

	it("carries observation relevance and timestamp on a hit", () => {
		const hit = searchMemory(ledger(), "adjudicator", { scope: "observations" }).hits[0];

		expect(hit.relevance).toBe("high");
		expect(hit.timestamp).toBe("2026-05-02T10:00:00.000Z");
	});

	it("returns no hits and names the unmatched terms when nothing matches", () => {
		const result = searchMemory(ledger(), "gibberishterm zzzz");

		expect(result.total).toBe(0);
		expect(result.hits).toEqual([]);
		expect(result.unmatchedTerms).toContain("gibberishterm");
	});

	it("treats a query of only single-character fragments as an enumeration", () => {
		expect(searchMemory(ledger(), "a b c").mode).toBe("enumerate");
	});

	it("pages a large result set with offset and reports the next offset", () => {
		const entries = [
			...ledger(),
			reflectionsRecordedEntry("ref-2", {
				coversUpToId: "raw-1",
				reflections: Array.from({ length: 6 }, (_, index) =>
					reflection(`00${index}000000000`, [OBSERVATION_ONE], { content: `ceiling detail number ${index}` }),
				),
			}),
		] as Entry[];

		const first = searchMemory(entries, "ceiling", { limit: 3 });
		expect(first.returned).toBe(3);
		expect(first.hasMore).toBe(true);
		expect(first.nextOffset).toBe(3);

		const second = searchMemory(entries, "ceiling", { limit: 3, offset: 3 });
		expect(second.offset).toBe(3);
		expect(second.hits.map((hit) => hit.id)).not.toEqual(first.hits.map((hit) => hit.id));
	});

	it("clamps an oversized limit to the maximum", () => {
		expect(searchMemory(ledger(), "ceiling", { limit: 5_000 }).limit).toBe(MEMORY_SEARCH_MAX_LIMIT);
		expect(searchMemory(ledger(), "ceiling").limit).toBe(MEMORY_SEARCH_DEFAULT_LIMIT);
	});

	it("bounds each hit's preview", () => {
		const long = "zebra ".repeat(400);
		const entries = [
			reflectionsRecordedEntry("ref-1", {
				coversUpToId: "raw-1",
				reflections: [reflection(REFLECTION_BUDGET, [OBSERVATION_ONE], { content: long })],
			}),
		] as Entry[];

		const hit = searchMemory(entries, "zebra").hits[0];

		expect(hit.contentTruncated).toBe(true);
		expect(hit.content.length).toBeLessThan(300);
	});
});

describe("support-link expansion", () => {
	it("reaches a reflection from wording that only matches the observation it cites", () => {
		const result = searchMemory(ledger(), "dropper proposes evictions");

		const linked = result.related.find((hit) => hit.id === REFLECTION_ADJUDICATOR);
		expect(linked).toBeDefined();
		expect(linked?.linkedFrom).toEqual({ id: OBSERVATION_ONE, kind: "observation" });
	});

	it("does not disturb the ranking of the direct hits", () => {
		const withLinks = searchMemory(ledger(), "dropper proposes evictions");
		const withoutLinks = searchMemory(ledger(), "dropper proposes evictions", { expandLinks: false });

		expect(withLinks.hits.map((hit) => hit.id)).toEqual(withoutLinks.hits.map((hit) => hit.id));
		expect(withLinks.hits[0].id).toBe(OBSERVATION_ONE);
		expect(withLinks.hits.every((hit) => hit.linkedFrom === undefined)).toBe(true);
	});

	it("surfaces a weakly-matching record that ranked past the page", () => {
		// The record matches the query but scores low (its text is padded, so length
		// normalization pushes it down) while its source observation matches short and
		// sharp. It is invisible to the caller on a one-result page, and the link puts it
		// back, reported as related rather than as a term hit.
		const weak = `The dropper proposes evictions. ${["padding detail about unrelated maintenance scheduling".repeat(12)]}`;
		const entries = [
			...ledger(),
			observationsRecordedEntry("om-obs-2", {
				coversUpToId: "raw-1",
				observations: [observation("aaaaaaaacccc", { content: "dropper proposes evictions alpha beta gamma delta" })],
			}),
			reflectionsRecordedEntry("om-ref-weak", {
				coversUpToId: "raw-1",
				reflections: [reflection("eeeeeeeeaaaa", [OBSERVATION_ONE], { content: weak })],
			}),
		] as Entry[];

		const result = searchMemory(entries, "dropper proposes evictions", { limit: 1 });

		expect(result.hits.map((hit) => hit.id)).not.toContain("eeeeeeeeaaaa");
		expect(result.related.map((hit) => hit.id)).toContain("eeeeeeeeaaaa");
		expect(result.related.find((hit) => hit.id === "eeeeeeeeaaaa")?.linkedFrom?.id).toBe(OBSERVATION_ONE);
	});

	it("never reports the same related record twice", () => {
		const result = searchMemory(ledger(), "adjudicator dropper evictions");

		expect(new Set(result.related.map((hit) => `${hit.kind}:${hit.id}`)).size).toBe(result.related.length);
	});

	it("does not link observations when scope is reflections only", () => {
		const result = searchMemory(ledger(), "dropper proposes evictions", { scope: "reflections" });

		// An observation cannot seed expansion when observations are not in scope, so a
		// query worded like the source finds nothing here. Both kinds must be in scope.
		expect(result.hits).toEqual([]);
		expect(result.related).toEqual([]);
	});

	it("can be turned off", () => {
		const result = searchMemory(ledger(), "dropper proposes evictions", { expandLinks: false });

		expect(result.hits.map((hit) => hit.id)).toEqual([OBSERVATION_ONE]);
		expect(result.related).toEqual([]);
		expect(result.directCount).toBe(result.total);
	});
});

describe("searchMemory enumeration mode", () => {
	it("returns the newest records first when there is no query", () => {
		const result = searchMemory(ledger(), "");

		expect(result.mode).toBe("enumerate");
		expect(result.total).toBe(5);
		expect(result.hits[0].id).toBe(REFLECTION_ADJUDICATOR);
		expect(result.hits[0].score).toBe(0);
	});

	it("pages through every record when nothing matches by content", () => {
		const entries = ledger();
		const seen: string[] = [];
		let offset = 0;
		for (;;) {
			const page = searchMemory(entries, "", { limit: 2, offset });
			seen.push(...page.hits.map((hit) => hit.id));
			if (!page.hasMore) break;
			offset = page.nextOffset ?? 0;
		}

		expect(seen.sort()).toEqual([REFLECTION_ADJUDICATOR, REFLECTION_BUDGET, REFLECTION_CEILING, OBSERVATION_ONE, OBSERVATION_TWO].sort());
	});

	it("reports an empty ledger rather than failing", () => {
		const result = searchMemory([], "");

		expect(result.total).toBe(0);
		expect(result.hits).toEqual([]);
		expect(result.hasMore).toBe(false);
	});

	it("honours the scope filter when enumerating", () => {
		expect(searchMemory(ledger(), "", { scope: "observations" }).hits.every((hit) => hit.kind === "observation")).toBe(true);
	});

	it("deduplicates a record recorded twice", () => {
		const duplicate = [...ledger(), ...ledger()] as Entry[];

		expect(searchMemory(duplicate, "", { scope: "reflections", limit: 25 }).total).toBe(3);
	});

	it("keeps an observation and a reflection that share a content-derived id", () => {
		// Both kinds use hashId(content) as their id, so identical text collides. Each
		// kind must still be found by its own scope.
		const shared = "the same durable sentence in both kinds";
		const entries = [
			observationsRecordedEntry("om-obs", {
				coversUpToId: "raw-1",
				observations: [observation("aaaaaaaaaaaa", { content: shared })],
			}),
			reflectionsRecordedEntry("om-ref", {
				coversUpToId: "raw-1",
				reflections: [reflection("aaaaaaaaaaaa", ["ddddddddeeee"], { content: shared })],
			}),
		] as Entry[];

		const both = searchMemory(entries, "durable sentence", { limit: 25 });
		expect(both.hits.map((hit) => hit.kind).sort()).toEqual(["observation", "reflection"]);
		expect(searchMemory(entries, "durable sentence", { scope: "reflections", limit: 25 }).total).toBe(1);
	});
});