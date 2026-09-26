import { describe, expect, it } from "vitest";

import {
	buildCompactionProjection,
	diffProjection,
	fullProjection,
	latestFullFoldBoundaryId,
	latestMemoryDetails,
	visibleProjection,
} from "../src/session-ledger/index.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

describe("session-ledger V3 projections", () => {
	it("full projection folds observations, reflections, and drops through the target", () => {
		const obs1 = observation("aaaaaaaaaaaa");
		const obs2 = observation("bbbbbbbbbbbb");
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1, obs2], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop-1", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-eeeeeeeeeeee" }),
		];

		const projection = fullProjection(entries);

		expect(projection.observations.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(projection.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
	});

	it("visible projection is empty when there is no V3 compaction", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
		];

		expect(visibleProjection(entries)).toEqual({ observations: [], reflections: [] });
	});

	it("visible projection uses the latest valid om.folded compaction details", () => {
		const obs1 = observation("aaaaaaaaaaaa");
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const obs2 = observation("bbbbbbbbbbbb");
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1", details: memoryDetails({ observations: [obs1], reflections: [] }) }),
			textCustomMessage("raw-2", "bbbb"),
			compactionEntry("cmp-2", { firstKeptEntryId: "raw-2", details: memoryDetails({ fullFold: true, observations: [obs2], reflections: [ref1] }) }),
		];

		expect(visibleProjection(entries)).toEqual({ observations: [obs2], reflections: [ref1] });
	});

	it("ignores old V2 compaction details for visible projection", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
		];

		expect(visibleProjection(entries)).toEqual({ observations: [], reflections: [] });
	});

	it("finds the latest full-fold boundary", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true }) }),
			textCustomMessage("raw-2", "bbbb"),
			compactionEntry("cmp-2", { firstKeptEntryId: "raw-2", details: memoryDetails({ fullFold: false }) }),
			textCustomMessage("raw-3", "cccc"),
			compactionEntry("cmp-3", { firstKeptEntryId: "raw-3", details: memoryDetails({ fullFold: true }) }),
		];

		expect(latestFullFoldBoundaryId(entries)).toBe("raw-3");
	});

	it("first normal compaction includes observations by coverage and excludes maintenance streams", () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-2"], tokenCount: 10 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-1", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];

		const result = buildCompactionProjection(entries, "raw-2", { observationsPoolMaxTokens: 100 });

		expect(result.fullFold).toBe(false);
		expect(result.observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(result.reflections).toEqual([]);
		expect(result.details).toMatchObject({ type: "om.folded", version: 1, fullFold: false });
	});

	it("normal compaction projection includes current observations but keeps reflections and drops at latest full-fold boundary", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 5 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];

		const result = buildCompactionProjection(entries, "raw-2", { observationsPoolMaxTokens: 100 });

		expect(result.fullFold).toBe(false);
		expect(result.observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(result.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
		expect(result.details).toMatchObject({ type: "om.folded", version: 1, fullFold: false });
	});

	it("full compaction projection applies reflections and drops through current boundary by coverage", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 80 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 30 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];

		const result = buildCompactionProjection(entries, "raw-2", { observationsPoolMaxTokens: 100 });

		expect(result.fullFold).toBe(true);
		expect(result.observations.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(result.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee", "ffffffffffff"]);
		expect(result.details).toMatchObject({ type: "om.folded", version: 1, fullFold: true });
	});

	it("ignores dangling coversUpToId markers during projection", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 10 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "missing" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "missing" }),
			observationsDroppedEntry("om-drop-1", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "missing" }),
		];

		expect(() => fullProjection(entries, "raw-1")).not.toThrow();
		expect(fullProjection(entries, "raw-1")).toEqual({ observations: [], reflections: [] });
	});

	it("keeps the first covered observation and reflection for duplicate ids", () => {
		const firstObs = observation("aaaaaaaaaaaa", { content: "first observation" });
		const secondObs = observation("aaaaaaaaaaaa", { content: "second observation" });
		const firstRef = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "first reflection" });
		const secondRef = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "second reflection" });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs-1", { observations: [firstObs], coversUpToId: "raw-1" }),
			observationsRecordedEntry("om-obs-2", { observations: [secondObs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref-1", { reflections: [firstRef], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref-2", { reflections: [secondRef], coversUpToId: "raw-1" }),
		];

		const projection = fullProjection(entries, "raw-1");

		expect(projection.observations).toEqual([firstObs]);
		expect(projection.reflections).toEqual([firstRef]);
	});

	it("uses >= observationsPoolMaxTokens for full-fold pressure", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 50 });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
		];

		expect(buildCompactionProjection(entries, "raw-1", { observationsPoolMaxTokens: 50 }).fullFold).toBe(true);
	});

	it("reports visible/full drift", () => {
		const visible = { observations: [observation("aaaaaaaaaaaa")], reflections: [] };
		const full = {
			observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")],
			reflections: [reflection("eeeeeeeeeeee", ["bbbbbbbbbbbb"])],
		};

		const diff = diffProjection(visible, full);

		expect(diff.observationsOnlyInFull.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(diff.reflectionsOnlyInFull.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
	});
});

describe("compaction projection reflection budget", () => {
	/** Three reflections whose rendered lines are 104 tokens each, plus one 80-token observation. */
	function budgetEntries() {
		const obs = observation("dddddddddddd", { tokenCount: 80 });
		const refs = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"].map((id) =>
			reflection(id, ["dddddddddddd"], { content: "x".repeat(400) }),
		);
		return [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-observations", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-reflections", { reflections: refs, coversUpToId: "raw-1" }),
		];
	}

	it("renders only the reflections that fit the budget and records them in details", () => {
		const result = buildCompactionProjection(budgetEntries(), "raw-1", {
			observationsPoolMaxTokens: 50,
			reflectionsBudgetTokens: 104,
			reflectionsIndexTokens: 30,
		});

		expect(result.fullFold).toBe(true);
		expect(result.reflections.map((ref) => ref.id)).toEqual(["cccccccccccc"]);
		// details stores the rendered set as ids; the summary carries the text the
		// model actually read.
		expect(result.details.reflectionIds).toEqual(["cccccccccccc"]);
		expect(result.reflectionBudget?.indexed.map((entry) => entry.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(result.reflectionBudget?.omittedCount).toBe(1);
	});

	it("renders every reflection when no budget is configured", () => {
		const result = buildCompactionProjection(budgetEntries(), "raw-1", { observationsPoolMaxTokens: 50 });

		expect(result.reflections.map((ref) => ref.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]);
		expect(result.details.reflectionIds).toHaveLength(3);
		expect(result.reflectionBudget).toBeUndefined();
	});

	it("bounds the full-fold projection as well", () => {
		const result = buildCompactionProjection(budgetEntries(), "raw-1", {
			observationsPoolMaxTokens: 10,
			reflectionsBudgetTokens: 1,
			reflectionsIndexTokens: 30,
		});

		expect(result.fullFold).toBe(true);
		expect(result.reflections).toEqual([]);
		expect(result.reflectionBudget?.indexed).toHaveLength(1);
		expect(result.reflectionBudget?.omittedCount).toBe(2);
	});
});

describe("session-ledger persisted reflection ids", () => {
	it("resolves a fold's rendered ids back to records, in the stored order", () => {
		const ref1 = reflection("eeeeeeeeeeee");
		const ref2 = reflection("ffffffffffff");
		const entries = [
			reflectionsRecordedEntry("om-refs-1", { reflections: [ref1, ref2], coversUpToId: "raw-1" }),
			compactionEntry("compact-1", {
				firstKeptEntryId: "raw-1",
				details: memoryDetails({ reflectionIds: ["ffffffffffff", "eeeeeeeeeeee"], reflections: [] }),
			}),
		];

		const visible = visibleProjection(entries);
		expect(visible.reflections.map((ref) => ref.id)).toEqual(["ffffffffffff", "eeeeeeeeeeee"]);
		expect(visible.reflections.map((ref) => ref.content)).toEqual([ref2.content, ref1.content]);
		expect(latestMemoryDetails(entries)?.reflections.map((ref) => ref.id)).toEqual(["ffffffffffff", "eeeeeeeeeeee"]);
	});

	it("marks an id that no longer resolves rather than dropping it", () => {
		// A shorter list would read as "the model saw less memory than it did".
		const entries = [
			compactionEntry("compact-1", { details: memoryDetails({ reflectionIds: ["aaaaaaaaaaaa"], reflections: [] }) }),
		];

		const visible = visibleProjection(entries);
		expect(visible.reflections).toHaveLength(1);
		expect(visible.reflections[0].content).toContain("unresolved reflection aaaaaaaaaaaa");
	});

	it("resolves stored observation ids back to records, in the stored order", () => {
		const obs1 = observation("aaaaaaaaaaaa");
		const obs2 = observation("bbbbbbbbbbbb");
		const entries = [
			observationsRecordedEntry("om-obs-1", { observations: [obs1, obs2], coversUpToId: "raw-1" }),
			compactionEntry("compact-1", {
				firstKeptEntryId: "raw-1",
				details: memoryDetails({ observationIds: ["bbbbbbbbbbbb", "aaaaaaaaaaaa"], observations: [] }),
			}),
		];

		const visible = visibleProjection(entries);
		expect(visible.observations.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
		expect(visible.observations.map((obs) => obs.content)).toEqual([obs2.content, obs1.content]);
	});

	it("marks an observation id that no longer resolves rather than dropping it", () => {
		const entries = [
			compactionEntry("compact-1", { details: memoryDetails({ observationIds: ["aaaaaaaaaaaa"], observations: [] }) }),
		];

		const visible = visibleProjection(entries);
		expect(visible.observations).toHaveLength(1);
		expect(visible.observations[0].content).toContain("unresolved observation aaaaaaaaaaaa");
	});

	it("leaves an entry carrying full arrays untouched", () => {
		const ref1 = reflection("eeeeeeeeeeee");
		const obs1 = observation("aaaaaaaaaaaa");
		const entries = [
			compactionEntry("compact-1", { details: memoryDetails({ observations: [obs1], reflections: [ref1] }) }),
		];

		const visible = visibleProjection(entries);
		expect(visible.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
		expect(visible.reflections[0].content).toBe(ref1.content);
		expect(visible.observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(visible.observations[0].content).toBe(obs1.content);
	});

	it("still finds the full-fold boundary on an ids-only entry", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("compact-1", {
				firstKeptEntryId: "raw-1",
				details: memoryDetails({ fullFold: true, reflectionIds: ["eeeeeeeeeeee"], reflections: [] }),
			}),
		];

		expect(latestFullFoldBoundaryId(entries)).toBe("raw-1");
	});
});

describe("session-ledger persisted reflection index ids", () => {
	const renderDetails = (overrides: Record<string, unknown> = {}) => ({
		policyVersion: 1,
		eligibleCount: 1,
		index: [],
		omittedCount: 0,
		fullTokens: 0,
		indexTokens: 0,
		fullBudgetTokens: 0,
		indexBudgetTokens: 0,
		...overrides,
	});

	it("rebuilds the index tier's previews from the stored ids", () => {
		const ref = reflection("bbbbbbbbbbbb", ["obs-1"], { content: "y".repeat(400) });
		const entries = [
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "raw-1" }),
			compactionEntry("compact-1", {
				details: memoryDetails({ reflectionRender: renderDetails({ indexIds: ["bbbbbbbbbbbb"] }) }),
			}),
		];

		// The preview is the content collapsed to one line and cut at the policy length.
		expect(latestMemoryDetails(entries)?.reflectionRender?.index).toEqual([
			{ id: "bbbbbbbbbbbb", preview: `${"y".repeat(90)}...` },
		]);
	});

	it("keeps the stored order and collapses whitespace the way the write side did", () => {
		const first = reflection("bbbbbbbbbbbb", ["obs-1"], { content: "first   with    gaps" });
		const second = reflection("cccccccccccc", ["obs-1"], { content: "second" });
		const entries = [
			reflectionsRecordedEntry("om-ref", { reflections: [first, second], coversUpToId: "raw-1" }),
			compactionEntry("compact-1", {
				details: memoryDetails({ reflectionRender: renderDetails({ indexIds: ["cccccccccccc", "bbbbbbbbbbbb"] }) }),
			}),
		];

		expect(latestMemoryDetails(entries)?.reflectionRender?.index).toEqual([
			{ id: "cccccccccccc", preview: "second" },
			{ id: "bbbbbbbbbbbb", preview: "first with gaps" },
		]);
	});

	it("uses the recorded preview width rather than the current default", () => {
		const ref = reflection("bbbbbbbbbbbb", ["obs-1"], { content: "y".repeat(400) });
		const entries = [
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "raw-1" }),
			compactionEntry("compact-1", {
				details: memoryDetails({
					reflectionRender: renderDetails({ indexIds: ["bbbbbbbbbbbb"], previewChars: 10 }),
				}),
			}),
		];

		expect(latestMemoryDetails(entries)?.reflectionRender?.index).toEqual([
			{ id: "bbbbbbbbbbbb", preview: `${"y".repeat(10)}...` },
		]);
	});

	it("leaves malformed index metadata alone instead of throwing", () => {
		const entries = [
			compactionEntry("compact-1", {
				details: memoryDetails({ reflectionRender: { ...renderDetails(), indexIds: "bbbbbbbbbbbb" } }),
			}),
		];

		// `isMemoryDetails` does not validate this field, so hydration must not trust it.
		expect(latestMemoryDetails(entries)?.reflectionRender?.index).toEqual([]);
	});

	it("marks an index id that no longer resolves rather than dropping it", () => {
		const entries = [
			compactionEntry("compact-1", {
				details: memoryDetails({ reflectionRender: renderDetails({ indexIds: ["ffffffffffff"] }) }),
			}),
		];

		expect(latestMemoryDetails(entries)?.reflectionRender?.index[0].preview).toContain("unresolved reflection ffffffffffff");
	});

	it("leaves a stored index untouched when the entry carries the pairs", () => {
		const stored = [{ id: "bbbbbbbbbbbb", preview: "stored preview" }];
		const entries = [
			compactionEntry("compact-1", {
				details: memoryDetails({ reflectionRender: renderDetails({ index: stored }) }),
			}),
		];

		expect(latestMemoryDetails(entries)?.reflectionRender?.index).toEqual(stored);
	});
});
