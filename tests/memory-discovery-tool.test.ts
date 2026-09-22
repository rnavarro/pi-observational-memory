import { describe, expect, it, vi } from "vitest";

import {
	SEARCH_MEMORY_TOOL_NAME,
	formatSearchMemoryCallForTui,
	formatSearchMemoryHeaderForTui,
	formatSearchMemoryResultForTui,
	registerSearchMemoryTool,
	searchMemoryTool,
} from "../src/tools/search-memory.js";
import { recallObservationTool } from "../src/tools/recall-observation.js";
import {
	observation,
	observationsRecordedEntry,
	rawMessage,
	reflection,
	reflectionsRecordedEntry,
	type TestEntry,
} from "./fixtures/session.js";

const OBSERVATION_ID = "ddddddddeeee";
const REFLECTION_ID = "aaaaaaaabbbb";

function fakeCtx(entries: TestEntry[]) {
	const getBranch = vi.fn(() => entries);
	const getEntries = vi.fn(() => {
		throw new Error("discovery tools must not use getEntries");
	});
	return { ctx: { sessionManager: { getBranch, getEntries } }, getBranch, getEntries };
}

async function runSearch(params: Record<string, unknown>, entries: TestEntry[]) {
	const { ctx, getBranch, getEntries } = fakeCtx(entries);
	const result = await searchMemoryTool.execute("tool-1", params, undefined as any, undefined as any, ctx as any);
	const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
	return { result, text, getBranch, getEntries };
}

async function runRecall(id: string, params: Record<string, unknown>, entries: TestEntry[]) {
	const { ctx } = fakeCtx(entries);
	const result = await recallObservationTool.execute("tool-1", { id, ...params }, undefined as any, undefined as any, ctx as any);
	const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
	return { result, text };
}

function memoryLedger(): TestEntry[] {
	return [
		rawMessage("raw-1", "session turn"),
		observationsRecordedEntry("om-obs", {
			coversUpToId: "raw-1",
			observations: [observation(OBSERVATION_ID, { content: "The dropper proposes evictions and the adjudicator reviews them", sourceEntryIds: ["raw-1"] })],
		}),
		reflectionsRecordedEntry("om-ref", {
			coversUpToId: "raw-1",
			reflections: [
				reflection(REFLECTION_ID, [OBSERVATION_ID], { content: "Reflections render under a reflections budget (reflectionsBudgetTokens) inside the fold summary" }),
				reflection("bbbbbbbbcccc", [OBSERVATION_ID], { content: "WS90 weather station reports via a GW2000B gateway" }),
			],
		}),
	];
}

describe("search_memory tool", () => {
	it("registers under its public name and renders its call", () => {
		const pi = { registerTool: vi.fn() };
		registerSearchMemoryTool(pi as any);

		expect(SEARCH_MEMORY_TOOL_NAME).toBe("search_memory");
		expect(searchMemoryTool.name).toBe("search_memory");
		expect(pi.registerTool).toHaveBeenCalledWith(searchMemoryTool);
		expect(formatSearchMemoryCallForTui({ query: "budget" })).toBe('search_memory "budget"');
		expect(formatSearchMemoryCallForTui({})).toBe("search_memory newest");
		expect(formatSearchMemoryCallForTui({ query: "   ", scope: "reflections", offset: 10 })).toBe("search_memory newest (reflections) offset=10");
	});

	it("finds an unrendered reflection by content and points at recall", async () => {
		const { result, text, getBranch, getEntries } = await runSearch({ query: "reflectionsBudgetTokens" }, memoryLedger());

		expect(getBranch).toHaveBeenCalledOnce();
		expect(getEntries).not.toHaveBeenCalled();
		expect(result.details?.mode).toBe("query");
		expect(result.details?.hits[0].id).toBe(REFLECTION_ID);
		expect(text).toContain(`[${REFLECTION_ID}]`);
		expect(text).toContain("recall with a hit's id");
	});

	it("searches every record in the ledger, not a rendered subset", async () => {
		const { result } = await runSearch({ query: "GW2000B", scope: "reflections" }, memoryLedger());

		expect(result.details?.hits.map((hit) => hit.id)).toEqual(["bbbbbbbbcccc"]);
	});

	it("browses the newest records when no query is given", async () => {
		const { text, result } = await runSearch({}, memoryLedger());

		expect(result.details?.mode).toBe("enumerate");
		expect(text).toContain("Browsing the newest");
		expect(text).toContain("No query given");
	});

	it("tells the caller when nothing matched and which terms were useless", async () => {
		const { text, result } = await runSearch({ query: "zzzzznothing" }, memoryLedger());

		expect(result.details?.total).toBe(0);
		expect(text).toContain("matched nothing");
	});

	it("reports pagination for a large result set", async () => {
		const entries: TestEntry[] = [
			...memoryLedger(),
			reflectionsRecordedEntry("om-ref-2", {
				coversUpToId: "raw-1",
				reflections: Array.from({ length: 5 }, (_, index) => reflection(`0000000000${index}0`, [OBSERVATION_ID], { content: `budget detail ${index}` })),
			}),
		];

		const { text, result } = await runSearch({ query: "budget", limit: 2 }, entries);

		expect(result.details?.returned).toBe(2);
		expect(result.details?.hasMore).toBe(true);
		expect(text).toContain("offset=2");
	});

	it("formats a TUI summary and rows", async () => {
		const { result } = await runSearch({ query: "budget" }, memoryLedger());

		expect(formatSearchMemoryHeaderForTui(result.details as any)).toContain("✓");
		const rendered = formatSearchMemoryResultForTui(result as any);
		expect(rendered).toContain(`[${REFLECTION_ID}]`);
		expect(rendered).toContain("reflection");
	});
});

describe("recall retrieval modes", () => {
	function evidenceLedger(sourceCount: number): TestEntry[] {
		const ids = Array.from({ length: sourceCount }, (_, index) => `raw-${index}`);
		return [
			...ids.map((id, index) => rawMessage(id, `evidence line ${index}`)),
			observationsRecordedEntry("om-obs", {
				coversUpToId: "raw-0",
				observations: [observation(OBSERVATION_ID, { content: "Durable fact with a long evidence trail", sourceEntryIds: ids })],
			}),
		];
	}

	it("returns record text only when sources: none is requested", async () => {
		const { result, text } = await runRecall(OBSERVATION_ID, { sources: "none" }, evidenceLedger(4));

		expect(text).toContain("Durable fact with a long evidence trail");
		expect(text).not.toContain("evidence line 0");
		expect(text).toContain("Source evidence omitted by request");
		expect(text).toContain("4 source entries exist");
		expect(result.details?.sourceEntries).toEqual([]);
	});

	it("pages source evidence and reports what remains", async () => {
		const { result, text } = await runRecall(OBSERVATION_ID, { sourceLimit: 2 }, evidenceLedger(5));

		expect(result.details?.sourceEntries.map((entry) => entry.id)).toEqual(["raw-0", "raw-1"]);
		expect(text).toContain("evidence line 0");
		expect(text).not.toContain("evidence line 2");
		expect(text).toContain("sourceOffset=2");
	});

	it("continues from a given source offset", async () => {
		const { result, text } = await runRecall(OBSERVATION_ID, { sourceLimit: 2, sourceOffset: 2 }, evidenceLedger(5));

		expect(result.details?.sourceEntries.map((entry) => entry.id)).toEqual(["raw-2", "raw-3"]);
		expect(text).toContain("evidence line 2");
		expect(text).toContain("sourceOffset=4");
	});

	it("returns full evidence and no pagination note when everything fits", async () => {
		const { text } = await runRecall(OBSERVATION_ID, {}, evidenceLedger(3));

		expect(text).toContain("evidence line 2");
		expect(text).not.toContain("Source evidence omitted by request");
		expect(text).not.toContain("sourceOffset=");
	});
});