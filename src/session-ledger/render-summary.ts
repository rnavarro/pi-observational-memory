import type { Observation, Reflection } from "./types.js";
import type { ReflectionIndexEntry } from "./reflection-budget.js";

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.
- Reflections under "Reflections (index)" are stored in full but only previewed here. Preview text is a hint, not an authority: use recall(<id>) to read one before relying on it.
- Reflections not listed at all are still stored. Find them with search_memory(<query>), or search_memory() with no query to browse the newest records.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed. Use search_memory when you need memory but have no id; it searches recorded memory by content, including records this summary does not list.`;

export function observationToSummaryLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function reflectionToSummaryLine(reflection: Reflection): string {
	return `[${reflection.id}] ${reflection.content}`;
}

export function reflectionIndexToSummaryLine(entry: ReflectionIndexEntry): string {
	return `[${entry.id}] ${entry.preview}`;
}

export type RenderSummaryOptions = {
	/** Reflections stored in full but rendered only as an id plus preview. */
	indexed?: ReflectionIndexEntry[];
	/** Reflections that fit in neither the full nor the index budget. */
	omittedCount?: number;
};

export function renderSummary(
	reflections: Reflection[],
	observations: Observation[],
	options: RenderSummaryOptions = {},
): string {
	const indexed = options.indexed ?? [];
	const omittedCount = options.omittedCount ?? 0;
	if (reflections.length === 0 && observations.length === 0 && indexed.length === 0 && omittedCount === 0) return "";

	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
	if (reflections.length > 0) {
		parts.push(`## Reflections\n${reflections.map(reflectionToSummaryLine).join("\n")}`);
	}
	if (indexed.length > 0) {
		parts.push(
			`## Reflections (index)\n${indexed.map(reflectionIndexToSummaryLine).join("\n")}`,
		);
	}
	if (omittedCount > 0) {
		parts.push(
			`${omittedCount} further reflection${omittedCount === 1 ? "" : "s"} recorded in this session ${omittedCount === 1 ? "is" : "are"} not shown here. They stay in the ledger: find one with search_memory(<query>), or search_memory() with no query to browse the newest records.`,
		);
	}
	if (observations.length > 0) {
		parts.push(`## Observations\n${observations.map(observationToSummaryLine).join("\n")}`);
	}
	return parts.join("\n\n");
}
