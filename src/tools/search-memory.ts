import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	MEMORY_SEARCH_DEFAULT_LIMIT,
	MEMORY_SEARCH_MAX_LIMIT,
	searchMemory,
	type Entry,
	type MemorySearchHit,
	type MemorySearchResult,
	type MemorySearchScope,
} from "../session-ledger/index.js";

export const SEARCH_MEMORY_TOOL_NAME = "search_memory";

const SCOPE_VALUES: readonly MemorySearchScope[] = ["reflections", "observations", "both"];

export type SearchMemoryToolDetails = MemorySearchResult;

function textResult(text: string, details: SearchMemoryToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function hitLine(hit: MemorySearchHit): string {
	const label = hit.kind === "reflection" ? `reflection, ${hit.supportCount ?? 0} support` : `observation [${hit.relevance ?? "unknown"}]`;
	const dropped = hit.dropped ? " [dropped]" : "";
	const score = hit.score > 0 ? `score ${hit.score}` : "newest-first";
	const terms = hit.matchedTerms.length > 0 ? ` matched: ${hit.matchedTerms.join(", ")}` : "";
	return `[${hit.id}] ${label}${dropped} · ${score}${terms}\n  ${hit.content}`;
}

function renderResultText(result: MemorySearchResult): string {
	const scopeLabel = result.scope === "both" ? "observations and reflections" : result.scope;
	const range = result.returned === 0 ? "0" : `${result.offset + 1}-${result.offset + result.returned}`;

	const lines: string[] = [];
	if (result.mode === "enumerate") {
		lines.push(
			result.total === 0
				? `No ${scopeLabel} are recorded on this branch yet.`
				: `Browsing the newest ${scopeLabel} (${range} of ${result.total}). No query given, so these are the most recent records, newest first.`,
		);
	} else {
		lines.push(
			result.total === 0
				? `No ${scopeLabel} matched "${result.query}".`
				: `Found ${result.total} matching ${scopeLabel} for "${result.query}" (${range} of ${result.total}, best first).`,
		);
	}

	if (result.offset > 0) lines.push(`Continuing from offset ${result.offset}.`);
	for (const hit of result.hits) lines.push("", hitLine(hit));

	if (result.related.length > 0) {
		lines.push(
			"",
			`Related records, reached through support links rather than the query terms (${result.related.length}):`,
		);
		for (const hit of result.related) {
			lines.push("", hitLine(hit), `  (related to [${hit.linkedFrom?.id ?? "unknown"}])`);
		}
	}

	if (result.unmatchedTerms.length > 0) {
		lines.push("", `These query terms matched nothing: ${result.unmatchedTerms.join(", ")}. Try fewer terms or different wording.`);
	}
	if (result.hasMore) {
		lines.push("", `More results available: call ${SEARCH_MEMORY_TOOL_NAME} again with offset=${result.nextOffset} for the next ${result.limit}.`);
	}
	if (result.hits.length > 0 || result.related.length > 0) {
		lines.push(
			"",
			"These are recorded summaries, not source evidence. Use recall with a hit's id when exact wording, provenance or source context matters.",
		);
	}
	return lines.join("\n").trimStart();
}

export function formatSearchMemoryCallForTui(args: { query?: string; scope?: string; offset?: number }): string {
	const scope = args.scope && args.scope !== "both" ? ` (${args.scope})` : "";
	const offset = args.offset ? ` offset=${args.offset}` : "";
	if (!args.query || args.query.trim().length === 0) return `${SEARCH_MEMORY_TOOL_NAME} newest${scope}${offset}`;
	return `${SEARCH_MEMORY_TOOL_NAME} "${args.query}"${scope}${offset}`;
}

export function formatSearchMemoryHeaderForTui(details: SearchMemoryToolDetails): string {
	const parts = [`${details.returned} of ${details.total}`];
	if (details.mode === "enumerate") parts.push("newest-first browse");
	else parts.push(`${details.scope} matches`);
	if (details.hasMore) parts.push("more available");
	return `✓ ${parts.join(" · ")}`;
}

export function formatSearchMemoryResultForTui(result: AgentToolResult<SearchMemoryToolDetails>): string {
	const details = result.details;
	if (!details) return "search_memory";
	const lines: string[] = [];
	for (const hit of details.hits) {
		const idPart = `[${hit.id}]`.padEnd(15);
		const kindPart = (hit.kind === "reflection" ? "reflection" : `observation${hit.dropped ? " dropped" : ""}`).padEnd(19);
		lines.push(`${idPart} ${kindPart} ${hit.content}`);
	}
	if (details.related.length > 0) {
		lines.push("", `related (${details.related.length}):`);
		for (const hit of details.related) lines.push(`  [${hit.id}] ${hit.content}`);
	}
	if (lines.length === 0) lines.push("no results");
	else lines.push("", "Use recall(<id>) for source evidence behind a hit.");
	return lines.join("\n");
}

export const searchMemoryTool = defineTool({
	name: SEARCH_MEMORY_TOOL_NAME,
	label: "Search compacted memory by content",
	description:
		"Search all recorded observational memory on the current branch by content, including reflections the fold summary only previewed or did not list. " +
		"Use when you need a memory you cannot address by id, or when the summary says reflections were not shown. " +
		"Omit the query to browse the newest records instead. Returns ids that recall can expand to source evidence.",
	promptSnippet:
		"Use search_memory(<query>) to find a compacted observation or reflection when you do not have its id; omit the query to browse the newest records.",
	promptGuidelines: [
		"Use search_memory when the fold summary lists only a preview of a reflection, or says some reflections were not shown, and one of them may bear on the task.",
		"Use search_memory when a decision depends on something from earlier in the session that no longer appears in the summary at all.",
		"Use search_memory with no query to browse the newest records when you know a fact exists but cannot guess the words it was written with.",
		"Prefer search_memory over guessing an id: recall needs a specific id, and this tool is how you find one.",
		"Use recall, not search_memory, when you already have an id and need exact wording, provenance, or source context.",
		"Do not call search_memory repeatedly with near-identical queries; reshape the query or browse by offset instead.",
	],
	parameters: Type.Object({
		query: Type.Optional(
			Type.String({
				description:
					"Words, identifiers, paths or a commit hash to look for. Matching keeps identifiers whole and also splits them into parts, so 'reflection budget' finds reflection-budget.ts. Omit or leave empty to browse the newest records instead.",
			}),
		),
		scope: Type.Optional(
			Type.Union([Type.Literal("reflections"), Type.Literal("observations"), Type.Literal("both")], {
				description: "Which kind of record to search. Defaults to both.",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: `Results per call, 1-${MEMORY_SEARCH_MAX_LIMIT}. Defaults to ${MEMORY_SEARCH_DEFAULT_LIMIT}.`,
			}),
		),
		offset: Type.Optional(
			Type.Number({
				description: "Skip this many results to page through a large result set. Defaults to 0.",
			}),
		),
	}),
	renderCall(args) {
		return new Text(formatSearchMemoryCallForTui(args), 0, 0);
	},
	renderResult(result) {
		return new Text(formatSearchMemoryResultForTui(result as AgentToolResult<SearchMemoryToolDetails>), 0, 0);
	},
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const query = typeof params.query === "string" ? params.query : "";
		const scope = typeof params.scope === "string" && (SCOPE_VALUES as readonly string[]).includes(params.scope) ? (params.scope as MemorySearchScope) : undefined;
		const branchEntries = ctx.sessionManager.getBranch() as Entry[];
		const result = searchMemory(branchEntries, query, {
			scope,
			limit: typeof params.limit === "number" ? params.limit : undefined,
			offset: typeof params.offset === "number" ? params.offset : undefined,
		});
		return textResult(renderResultText(result), result);
	},
});

export function registerSearchMemoryTool(pi: ExtensionAPI): void {
	pi.registerTool(searchMemoryTool);
}