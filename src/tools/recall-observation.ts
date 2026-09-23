import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	recallMemorySources,
	type Entry,
	type RecallResult,
	type RecalledObservation,
} from "../session-ledger/recall.js";
import type { Observation, Reflection } from "../session-ledger/index.js";
import { renderRecallSourceEntries, renderRecallSourceEntry } from "../serialize.js";
import { estimateEntryTokens } from "../tokens.js";

export const RECALL_OBSERVATION_TOOL_NAME = "recall";

/** Source entries returned per recall call before the response asks to be paged. */
export const RECALL_DEFAULT_SOURCE_LIMIT = 20;
export const RECALL_MAX_SOURCE_LIMIT = 100;

function normalizeOffset(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeSourceLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return RECALL_DEFAULT_SOURCE_LIMIT;
	return Math.min(Math.floor(value), RECALL_MAX_SOURCE_LIMIT);
}

const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

type RecallObservationToolStatus =
	| "ok"
	| "partial"
	| "invalid_id"
	| "not_found"
	| "no_source"
	| "source_unavailable";

type ObservationDetails = Pick<Observation, "id" | "content" | "timestamp" | "relevance"> & { status?: "active" | "dropped" };
type ReflectionDetails = Pick<Reflection, "id" | "content" | "supportingObservationIds"> & { reflectionIndex: number };

export type RecallSourceEntryDetails = {
	id: string;
	origin: string;
	timestamp: string;
	tokens: number;
	qualifiers: string[];
	content?: string;
};

type RecallObservationMatchDetails = {
	status: "active" | "dropped" | "source_unavailable" | "no_source";
	observationEntryId: string;
	observationRecordIndex: number;
	observation: ObservationDetails;
	sourceEntryIds?: string[];
	sourceEntries?: RecallSourceEntryDetails[];
	missingSourceEntryIds?: string[];
	nonSourceEntryIds?: string[];
	sourceCharacterCount?: number;
};

type RecallUnavailableSupportingObservationDetails = {
	observationId: string;
};

export type RecallObservationToolDetails = {
	status: RecallObservationToolStatus;
	memoryId: string;
	observationId: string;
	collision: boolean;
	partial: boolean;
	reflections: ReflectionDetails[];
	directObservationMatches: RecallObservationMatchDetails[];
	observations: RecallObservationMatchDetails[];
	matches: RecallObservationMatchDetails[];
	sourceEntries: RecallSourceEntryDetails[];
	unavailableSupportingObservations: RecallUnavailableSupportingObservationDetails[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
	sourceCharacterCount?: number;
	message?: string;
};

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

function fmtLocal(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDisplayTimestamp(...values: Array<number | string | undefined>): string {
	for (const v of values) {
		if (v === undefined) continue;
		const d = new Date(v);
		if (!Number.isNaN(d.getTime())) return fmtLocal(d);
	}
	return "Unknown time";
}

function textContentBlocks(content: unknown): Array<Record<string, unknown>> {
	return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object") : [];
}

function uniqueStrings(items: string[]): string[] {
	return Array.from(new Set(items));
}

function sourceOriginAndQualifiers(entry: Entry): { origin: string; timestamp: string; qualifiers: string[] } {
	if (entry.type === "message" && entry.message && typeof entry.message === "object") {
		const msg = entry.message as Message;
		const timestamp = formatDisplayTimestamp(msg.timestamp, entry.timestamp);
		if (msg.role === "user") return { origin: "User", timestamp, qualifiers: [] };
		if (msg.role === "assistant") {
			const toolCalls = uniqueStrings(
				textContentBlocks(msg.content)
					.filter((block) => block.type === "toolCall" && typeof block.name === "string")
					.map((block) => block.name as string),
			);
			return { origin: "Assistant", timestamp, qualifiers: toolCalls.length > 0 ? [`tool calls: ${toolCalls.join(", ")}`] : [] };
		}
		const toolName = (msg as ToolResultMessage).toolName;
		return { origin: `Tool result: ${typeof toolName === "string" && toolName ? toolName : "unknown"}`, timestamp, qualifiers: [] };
	}
	if (entry.type === "custom_message") {
		return {
			origin: "Custom message",
			timestamp: formatDisplayTimestamp(entry.timestamp),
			qualifiers: typeof entry.customType === "string" && entry.customType ? [`custom: ${entry.customType}`] : [],
		};
	}
	if (entry.type === "branch_summary") return { origin: "Branch summary", timestamp: formatDisplayTimestamp(entry.timestamp), qualifiers: [] };
	return { origin: entry.type || "Entry", timestamp: formatDisplayTimestamp(entry.timestamp), qualifiers: [] };
}

function renderSourceEntryContentOnly(entry: Entry): string | undefined {
	const rendered = renderRecallSourceEntry(entry);
	return rendered?.replace(/^\[[^\]]+\]:\s?/, "") || undefined;
}

function sourceEntryDetails(entry: Entry, includeContent: boolean): RecallSourceEntryDetails {
	const { origin, timestamp, qualifiers } = sourceOriginAndQualifiers(entry);
	const content = renderSourceEntryContentOnly(entry);
	return {
		id: entry.id,
		origin,
		timestamp,
		tokens: estimateEntryTokens(entry),
		qualifiers,
		...(includeContent && content ? { content } : {}),
	};
}

function observationDetails(observation: Observation, status?: "active" | "dropped"): ObservationDetails {
	return { id: observation.id, content: observation.content, timestamp: observation.timestamp, relevance: observation.relevance, ...(status ? { status } : {}) };
}

function reflectionDetails(reflection: Reflection, reflectionIndex: number): ReflectionDetails {
	return { id: reflection.id, content: reflection.content, supportingObservationIds: reflection.supportingObservationIds, reflectionIndex };
}

function observationMatchDetails(match: RecalledObservation, includeSourceContent = true): RecallObservationMatchDetails {
	const unavailable = match.missingSourceEntryIds.length > 0 || match.nonSourceEntryIds.length > 0;
	const status = unavailable ? "source_unavailable" : match.sourceEntries.length === 0 ? "no_source" : match.status;
	return {
		status,
		observationEntryId: match.observationEntryId,
		observationRecordIndex: match.observationRecordIndex,
		observation: observationDetails(match.observation, match.status),
		sourceEntryIds: match.sourceEntryIds,
		sourceEntries: match.sourceEntries.map((entry) => sourceEntryDetails(entry, includeSourceContent)),
		missingSourceEntryIds: match.missingSourceEntryIds,
		nonSourceEntryIds: match.nonSourceEntryIds,
		sourceCharacterCount: renderRecallSourceEntries(match.sourceEntries).length,
	};
}

function textResult(text: string, details: RecallObservationToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function emptyDetails(status: RecallObservationToolStatus, memoryId: string, message: string): RecallObservationToolDetails {
	return {
		status,
		memoryId,
		observationId: memoryId,
		collision: false,
		partial: false,
		reflections: [],
		directObservationMatches: [],
		observations: [],
		matches: [],
		sourceEntries: [],
		unavailableSupportingObservations: [],
		missingSourceEntryIds: [],
		nonSourceEntryIds: [],
		message,
	};
}

function aggregateStatus(details: Omit<RecallObservationToolDetails, "status">): RecallObservationToolStatus {
	const observationOnly = details.reflections.length === 0 && details.unavailableSupportingObservations.length === 0;
	if (details.partial) return "partial";
	if (observationOnly && details.observations.some((match) => match.status === "source_unavailable")) return "source_unavailable";
	if (observationOnly && details.observations.length > 0 && details.sourceEntries.length === 0 && details.matches.every((match) => (match.sourceEntries ?? []).length === 0)) return "no_source";
	return "ok";
}

function friendlyNoSourceMessage(memoryId: string): string {
	return `Observation ${memoryId} has no source entries associated with it.`;
}

function friendlySourceUnavailableMessage(match: RecallObservationMatchDetails): string {
	const missing = match.missingSourceEntryIds && match.missingSourceEntryIds.length > 0 ? ` missing: ${match.missingSourceEntryIds.join(", ")}` : "";
	const nonSource = match.nonSourceEntryIds && match.nonSourceEntryIds.length > 0 ? ` non-source: ${match.nonSourceEntryIds.join(", ")}` : "";
	return `Observation ${match.observation.id} has source entries associated, but some are unavailable on the current branch or are not source-renderable.${missing}${nonSource}`;
}

function reflectionLineText(reflection: ReflectionDetails): string {
	return `[${reflection.id}] ${reflection.content}`;
}

function observationLineText(observation: ObservationDetails): string {
	const status = observation.status === "dropped" ? " [dropped]" : "";
	return `[${observation.id}]${status} ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

function directObservationMatches(result: Extract<RecallResult, { status: "found" }>): RecalledObservation[] {
	return result.observations.filter((match) => match.observation.id === result.memoryId);
}

/** How much of a record's source evidence this call returned, and what is left. */
type SourcePage = {
	offset: number;
	limit: number;
	total: number;
	shown: number;
	/** Observation matches whose sources exist but fell outside this page. */
	pagedOutObservationIds: Set<string>;
};

function renderObservationOnlyTextFromResult(result: Extract<RecallResult, { status: "found" }>, page?: SourcePage): string {
	const sections: string[] = [];
	if (result.collision) sections.push(`Memory id ${result.memoryId} matched multiple observations; returning all matching source results from the current branch.`);
	for (const match of directObservationMatches(result)) {
		// Always render the record itself: this path exists so the record text can be
		// read without its evidence trail (sources: none), which would otherwise return
		// nothing but a note.
		sections.push(observationLineText(observationDetails(match.observation, match.status)));
		if (match.status === "dropped") sections.push(`Observation ${match.observation.id} is dropped from active memory but remains recallable.`);
		if (match.missingSourceEntryIds.length > 0 || match.nonSourceEntryIds.length > 0) {
			sections.push(friendlySourceUnavailableMessage(observationMatchDetails(match, false)));
			continue;
		}
		if (match.sourceEntries.length === 0) {
			if (page?.pagedOutObservationIds.has(match.observation.id)) {
				sections.push(`Observation ${match.observation.id} has source entries, but none fall in this page of ${page.total}.`);
				continue;
			}
			sections.push(friendlyNoSourceMessage(match.observation.id));
			continue;
		}
		const sourceText = renderRecallSourceEntries(match.sourceEntries);
		sections.push(sourceText.trim() ? sourceText : `Observation ${match.observation.id} has source entries associated, but they rendered no text content.`);
	}
	return sections.join("\n\n");
}

function unavailableSupportingLineText(item: RecallUnavailableSupportingObservationDetails): string {
	return `Supporting observation ${item.observationId} is unavailable on the current branch.`;
}

function renderMemoryText(result: Extract<RecallResult, { status: "found" }>): string {
	const sections: string[] = [];
	if (result.collision) sections.push(`Memory id ${result.memoryId} matched multiple observations/reflections; returning all available evidence from the current branch.`);
	if (result.reflections.length > 0) sections.push(`Reflections:\n${result.reflections.map((match) => reflectionLineText(reflectionDetails(match.reflection, match.reflectionRecordIndex))).join("\n")}`);
	if (result.observations.length > 0) sections.push(`Observations:\n${result.observations.map((match) => observationLineText(observationDetails(match.observation, match.status))).join("\n")}`);
	if (result.missingSupportingObservationIds.length > 0) sections.push(`Unavailable supporting observations:\n${result.missingSupportingObservationIds.map((id) => unavailableSupportingLineText({ observationId: id })).join("\n")}`);
	if (result.missingSourceEntryIds.length > 0 || result.nonSourceEntryIds.length > 0) {
		const parts: string[] = [];
		if (result.missingSourceEntryIds.length > 0) parts.push(`missing: ${result.missingSourceEntryIds.join(", ")}`);
		if (result.nonSourceEntryIds.length > 0) parts.push(`non-source: ${result.nonSourceEntryIds.join(", ")}`);
		sections.push(`Unavailable source entries: ${parts.join("; ")}`);
	}
	const sourceText = renderRecallSourceEntries(result.sourceEntries);
	if (sourceText.trim()) sections.push(`Sources:\n${sourceText}`);
	if (sections.length === 0) sections.push(`Memory ${result.memoryId} was found, but no source evidence rendered.`);
	return sections.join("\n\n");
}

function resultDetails(result: Extract<RecallResult, { status: "found" }>, includeSourceContent = true): RecallObservationToolDetails {
	const reflections = result.reflections.map((match) => reflectionDetails(match.reflection, match.reflectionRecordIndex));
	const observations = result.observations.map((match) => observationMatchDetails(match, includeSourceContent));
	const directMatches = directObservationMatches(result).map((match) => observationMatchDetails(match, includeSourceContent));
	const sourceEntries = result.sourceEntries.map((entry) => sourceEntryDetails(entry, includeSourceContent));
	const detailWithoutStatus = {
		memoryId: result.memoryId,
		observationId: result.memoryId,
		collision: result.collision,
		partial: result.partial,
		reflections,
		directObservationMatches: directMatches,
		observations,
		matches: directMatches,
		sourceEntries,
		unavailableSupportingObservations: result.missingSupportingObservationIds.map((observationId) => ({ observationId })),
		missingSourceEntryIds: result.missingSourceEntryIds,
		nonSourceEntryIds: result.nonSourceEntryIds,
		sourceCharacterCount: renderRecallSourceEntries(result.sourceEntries).length,
	};
	return { status: aggregateStatus(detailWithoutStatus), ...detailWithoutStatus };
}

function isObservationOnly(details: RecallObservationToolDetails): boolean {
	return details.reflections.length === 0 && details.unavailableSupportingObservations.length === 0;
}

function renderFoundResult(result: Extract<RecallResult, { status: "found" }>, page?: SourcePage): ReturnType<typeof textResult> {
	const details = resultDetails(result);
	const text = result.kind === "observation" ? renderObservationOnlyTextFromResult(result, page) : renderMemoryText(result);
	return textResult(text, details);
}

function uniqueEntriesById(entries: Entry[]): Entry[] {
	const seen = new Set<string>();
	return entries.filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));
}

/**
 * Bound how much source evidence one recall call returns.
 *
 * Two render paths exist: an observation recall renders each match's own source list,
 * while a reflection recall renders the union list. Both are paged so the returned
 * text never exceeds the requested budget, and the union list is derived from whatever
 * was actually shown so the tool details match the text.
 */
function pageSources(result: Extract<RecallResult, { status: "found" }>, offset: number, limit: number, includeSources: boolean): {
	result: Extract<RecallResult, { status: "found" }>;
	page: SourcePage;
} {
	const total = result.sourceEntries.length;
	const pagedOutObservationIds = new Set<string>();

	if (!includeSources) {
		for (const match of result.observations) if (match.sourceEntries.length > 0) pagedOutObservationIds.add(match.observation.id);
		return {
			result: { ...result, sourceEntries: [], observations: result.observations.map((match) => ({ ...match, sourceEntries: [] })) },
			page: { offset, limit, total, shown: 0, pagedOutObservationIds },
		};
	}

	if (offset === 0 && total <= limit) {
		return { result, page: { offset, limit, total, shown: total, pagedOutObservationIds } };
	}

	if (result.kind === "observation") {
		let cursor = 0;
		let shown = 0;
		const observations = result.observations.map((match) => {
			const kept: Entry[] = [];
			for (const entry of match.sourceEntries) {
				const position = cursor++;
				if (position < offset) continue;
				if (shown < limit) {
					kept.push(entry);
					shown++;
				}
			}
			if (match.sourceEntries.length > 0 && kept.length === 0) pagedOutObservationIds.add(match.observation.id);
			return { ...match, sourceEntries: kept };
		});
		const sourceEntries = uniqueEntriesById(observations.flatMap((match) => match.sourceEntries));
		return { result: { ...result, observations, sourceEntries }, page: { offset, limit, total, shown: sourceEntries.length, pagedOutObservationIds } };
	}

	const sourceEntries = result.sourceEntries.slice(offset, offset + limit);
	return { result: { ...result, sourceEntries }, page: { offset, limit, total, shown: sourceEntries.length, pagedOutObservationIds } };
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
	return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`;
}

function sourceEntriesFromDetails(details: RecallObservationToolDetails): RecallSourceEntryDetails[] {
	if (!isObservationOnly(details)) return details.sourceEntries;
	return details.matches.flatMap((match) => match.sourceEntries ?? []);
}

function tokenSummary(tokens: number): string {
	return `~${tokens.toLocaleString()} ${tokens === 1 ? "token" : "tokens"}`;
}

function isFailureStatus(status: RecallObservationToolStatus): boolean {
	return status === "invalid_id" || status === "not_found";
}

function observationCountForHeader(details: RecallObservationToolDetails): number {
	return isObservationOnly(details) ? details.matches.length : details.observations.length;
}

export function formatRecallHeaderForTui(details: RecallObservationToolDetails): string {
	if (isFailureStatus(details.status)) return "× failure";
	const parts = ["✓ success"];
	if (details.reflections.length > 0) parts.push(plural(details.reflections.length, "reflection"));
	const observations = observationCountForHeader(details);
	if (observations > 0) parts.push(plural(observations, "observation"));
	const sources = sourceEntriesFromDetails(details);
	if (sources.length > 0) parts.push(plural(sources.length, "source"));
	const tokens = sources.reduce((sum, source) => sum + source.tokens, 0);
	if (tokens > 0) parts.push(tokenSummary(tokens));
	if (details.partial && details.status !== "ok") parts.push(details.status.replace(/_/g, " "));
	return parts.join(" · ");
}

const TUI_TYPE_WIDTH = 15;
const TUI_META_WIDTH = 31;

function alignedRow(type: string, meta: string, text: string): string {
	return `${type.padEnd(TUI_TYPE_WIDTH)} ${meta.padEnd(TUI_META_WIDTH)} ${text}`.trimEnd();
}

function sourceTag(source: RecallSourceEntryDetails): string {
	const origin = source.origin.trim().toLowerCase();
	if (origin === "user") return "user";
	if (origin === "assistant") return "assistant";
	if (origin.startsWith("tool result")) return "tool";
	if (origin.startsWith("custom message")) return "custom";
	if (origin.startsWith("branch summary")) return "summary";
	return origin.split(/[^a-z0-9]+/).find(Boolean) ?? "entry";
}

function sourceMetadataLine(source: RecallSourceEntryDetails): string {
	return alignedRow("✓ source", `${source.timestamp} [${sourceTag(source)}]`, tokenSummary(source.tokens));
}

function observationLine(observation: ObservationDetails): string {
	const status = observation.status === "dropped" ? " dropped" : "";
	return alignedRow("✓ observation", `${observation.timestamp} [${observation.relevance}]${status}`, observation.content);
}

function reflectionLine(reflection: ReflectionDetails): string {
	return alignedRow("✓ reflection", "", reflection.content);
}

function noteLine(kind: string, text: string): string {
	return alignedRow("• note", `[${kind}]`, text);
}

function indentContent(content: string): string {
	return content.split("\n").map((line) => `    ${line}`).join("\n");
}

function unavailableEvidenceMessage(_details: RecallObservationToolDetails): string {
	return "no source entries are available for this memory id";
}

function pushSourceLines(lines: string[], sources: RecallSourceEntryDetails[], expanded: boolean): void {
	for (const source of sources) {
		lines.push(sourceMetadataLine(source));
		if (expanded && source.content) {
			lines.push(indentContent(source.content));
			lines.push("");
		}
	}
}

function memoryRows(details: RecallObservationToolDetails): string[] {
	if (isObservationOnly(details)) return details.matches.map((match) => observationLine(match.observation));
	return [...details.reflections.map((reflection) => reflectionLine(reflection)), ...details.observations.map((observation) => observationLine(observation.observation))];
}

function noteRows(details: RecallObservationToolDetails, sources: RecallSourceEntryDetails[]): string[] {
	const notes: string[] = [];
	if (details.status === "invalid_id") {
		notes.push(noteLine("invalid id", `memory ids must be 12 lowercase hex characters; received ${details.memoryId}`));
		return notes;
	}
	if (details.status === "not_found") {
		notes.push(noteLine("not found", `no observation or reflection with id ${details.memoryId} was found on the current branch`));
		return notes;
	}
	if (details.collision) notes.push(noteLine("id collision", `multiple memory items share ${details.memoryId}`));
	if (details.observations.some((match) => match.observation.status === "dropped")) notes.push(noteLine("dropped", "one or more observations are dropped from active memory but remain recallable"));
	if (details.unavailableSupportingObservations.length > 0) notes.push(noteLine("missing support", details.unavailableSupportingObservations.map((item) => item.observationId).join(", ")));
	if (details.missingSourceEntryIds.length > 0) notes.push(noteLine("missing source", details.missingSourceEntryIds.join(", ")));
	if (details.nonSourceEntryIds.length > 0) notes.push(noteLine("non-source", details.nonSourceEntryIds.join(", ")));
	if (sources.length === 0 && (details.reflections.length > 0 || details.observations.length > 0 || details.matches.length > 0)) notes.push(noteLine("unavailable evidence", unavailableEvidenceMessage(details)));
	return notes;
}

export function formatRecallResultForTui(result: AgentToolResult<RecallObservationToolDetails>, expanded: boolean): string {
	const details = result.details;
	if (!details) {
		const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
		return text || "recall";
	}
	const sources = sourceEntriesFromDetails(details);
	const lines: string[] = [];
	const rows = memoryRows(details);
	const notes = noteRows(details, sources);
	lines.push(...rows);
	if (rows.length > 0 && notes.length > 0) lines.push("");
	lines.push(...notes);
	if ((rows.length > 0 || notes.length > 0) && sources.length > 0) lines.push("");
	pushSourceLines(lines, sources, expanded);
	if (!expanded && sources.some((source) => source.content)) lines.push("", "(Ctrl+O to expand)");
	return lines.join("\n").trimEnd();
}

export function formatRecallCallForTui(id: string | undefined): string {
	return `recall ${id ?? "..."}`;
}

export function formatRecallRenderedResultForTui(result: AgentToolResult<RecallObservationToolDetails>, expanded: boolean): string {
	const body = formatRecallResultForTui(result, expanded);
	const header = result.details ? formatRecallHeaderForTui(result.details) : undefined;
	if (header && body) return `\n${header}\n\n${body}`;
	if (header) return `\n${header}`;
	return body ? `\n${body}` : "";
}

export const recallObservationTool = defineTool({
	name: RECALL_OBSERVATION_TOOL_NAME,
	label: "Recall memory evidence",
	description:
		"Recover exact evidence and source context behind a compacted observational-memory observation or reflection id on the current branch. " +
		"Use when compressed memory is important and original source context is needed before acting.",
	promptSnippet: "Use recall(<id>) to recover exact source context behind compacted memory observations/reflections when precision matters.",
	promptGuidelines: [
		"Use recall before making an important decision that depends on a compacted observation or reflection whose details are unclear.",
		"Use recall when you need exact wording, rationale, file paths, commands, errors, commits, user constraints, or provenance behind a remembered claim.",
		"Use recall when a broad reflection is relevant but you need its supporting observations or raw sources to continue safely.",
		"Use recall when the user asks why you believe something, what supports a memory, or what was decided earlier.",
		"Do not use recall as semantic search or transcript browsing; you must already have a specific 12-character memory id.",
		"Do not recall every id preemptively. Recall only when exact source context will materially improve the next action.",
	],
	parameters: Type.Object({
		id: Type.String({
			pattern: "^[a-f0-9]{12}$",
			description: "12-character lowercase hex observation or reflection id shown in compacted memory, /om:view, or a previous recall or search_memory result. Must be a specific id; use search_memory to find one by content.",
		}),
		sources: Type.Optional(
			Type.Union([Type.Literal("full"), Type.Literal("none")], {
				description:
					"'full' (default) includes the raw source entries behind the record. 'none' returns the record text alone, which is the cheap way to expand an id found via search_memory without pulling its whole evidence trail into context.",
			}),
		),
		sourceOffset: Type.Optional(
			Type.Number({
				description: "Skip this many source entries, to page through a record with a large evidence trail. Defaults to 0.",
			}),
		),
		sourceLimit: Type.Optional(
			Type.Number({
				description: `Source entries per call, at most ${RECALL_MAX_SOURCE_LIMIT}. Defaults to ${RECALL_DEFAULT_SOURCE_LIMIT}; the response reports how many remain.`,
			}),
		),
	}),
	renderCall(args) {
		return new Text(formatRecallCallForTui(args.id), 0, 0);
	},
	renderResult(result, options) {
		return new Text(formatRecallRenderedResultForTui(result as AgentToolResult<RecallObservationToolDetails>, options.expanded), 0, 0);
	},
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const memoryId = params.id;
		if (!MEMORY_ID_PATTERN.test(memoryId)) {
			const message = `Memory id must be 12 lowercase hex characters. Received: ${memoryId}`;
			return textResult(message, emptyDetails("invalid_id", memoryId, message));
		}
		const branchEntries = ctx.sessionManager.getBranch() as Entry[];
		const result = recallMemorySources(branchEntries, memoryId);
		if (result.status === "not_found") {
			const message = `No observation or reflection with id ${memoryId} was found on the current branch.`;
			return textResult(message, emptyDetails("not_found", memoryId, message));
		}

		const includeSources = params.sources !== "none";
		const offset = normalizeOffset(params.sourceOffset);
		const limit = normalizeSourceLimit(params.sourceLimit);
		const { result: pagedResult, page } = pageSources(result, offset, limit, includeSources);
		const rendered = renderFoundResult(pagedResult, page);

		const notes: string[] = [];
		if (!includeSources && page.total > 0) {
			notes.push(`Source evidence omitted by request (sources: none). ${page.total} source entries exist; call recall again without sources: none to read them.`);
		} else if (includeSources && offset + page.shown < page.total) {
			const range = page.shown === 0 ? "no" : `${offset + 1}-${offset + page.shown}`;
			notes.push(`Showing ${range} of ${page.total} source entries. Call recall again with sourceOffset=${offset + page.shown} to continue.`);
		}
		if (notes.length === 0) return rendered;

		const body = rendered.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
		return textResult([body, notes.join("\n")].filter(Boolean).join("\n\n"), rendered.details);
	},
});

export function registerRecallTool(pi: ExtensionAPI): void {
	pi.registerTool(recallObservationTool);
}
