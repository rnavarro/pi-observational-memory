import {
	previewReflectionContent,
	reflectionIndexLineTokenCount,
	reflectionLineTokenCount,
} from "../tokens.js";
import type { Reflection } from "./types.js";

/**
 * The observation pool has a ceiling; reflections had no bound at all.
 *
 * Measured across 1846 real folds: rendered reflection text reached 156,663
 * tokens (984 reflections) in a single fold and formed 61% of the rendered
 * memory payload at median, 94% at worst. Because the fold summary replaces the
 * model's context after compaction, that is a direct claim on the context
 * window, and in the worst measured case the summary occupied 51% of a 272K
 * window.
 *
 * The budget bounds only what is *rendered*. Every reflection stays in the
 * ledger and stays reachable through the recall tool, and the tail is rendered
 * as an index of ids with a short preview so the model can see that the record
 * exists before asking for it. Silently dropping reflections from the summary
 * would make them unreachable in practice (the model would never learn the id),
 * which is why the index tier exists rather than a bare truncation.
 */

/** Full-text reflection rendering budget, default. */
export const DEFAULT_REFLECTIONS_BUDGET_TOKENS = 20_000;
/** Upper bound on the index tier that renders ids plus previews for the rest. */
export const DEFAULT_REFLECTIONS_INDEX_TOKENS = 5_000;
/** Ratio cap on the full-text budget, so small-window models stay proportionate. */
export const DEFAULT_REFLECTIONS_BUDGET_RATIO = 0.1;
/** Characters of reflection content kept on an index line. */
export const REFLECTION_INDEX_PREVIEW_CHARS = 90;

export type ReflectionIndexEntry = {
	id: string;
	preview: string;
};

export type ReflectionBudgetSelection = {
	/** Reflections rendered in full, in ledger order. */
	rendered: Reflection[];
	/** Reflections rendered as id plus preview, newest first, within the index budget. */
	indexed: ReflectionIndexEntry[];
	/** Reflections that fit in neither tier; still in the ledger and recallable. */
	omittedCount: number;
	/** The preview width the index tier was rendered at, recorded with the fold. */
	previewChars: number;
	renderedTokens: number;
	indexedTokens: number;
};

/**
 * Resolve the full-text budget. Shape mirrors the observation ceiling:
 * `min(fixed, ratio x contextWindow)` so a small window cannot be handed a
 * fixed budget it cannot hold, while a very large advertised window does not
 * produce an unbounded budget.
 */
export function computeReflectionsBudgetTokens(options: {
	contextWindow?: number;
	fixedTokens: number;
	ratio: number;
}): number {
	const fixedTokens =
		Number.isFinite(options.fixedTokens) && options.fixedTokens > 0
			? options.fixedTokens
			: DEFAULT_REFLECTIONS_BUDGET_TOKENS;
	const contextWindow = options.contextWindow;
	const ratio = options.ratio;

	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0 && Number.isFinite(ratio) && ratio > 0) {
		return Math.max(1, Math.min(fixedTokens, Math.floor(contextWindow * ratio)));
	}
	return fixedTokens;
}

/**
 * Choose which reflections are rendered in full and which fall to the index.
 *
 * Order is newest-first in ledger order (reflections are append-only, so ledger
 * order is chronological): the current state of a session is carried by its
 * later reflections, and the observation pool is already recency-bounded by the
 * fold boundary. `protectedIds` are rendered before anything else, for callers
 * that know a reflection is load-bearing (for example one that supports a live
 * high or critical observation). The returned `rendered` list is restored to
 * ledger order so the summary reads chronologically.
 */
export function selectReflectionBudget(
	reflections: Reflection[],
	options: {
		budgetTokens: number;
		indexTokens: number;
		protectedIds?: ReadonlySet<string>;
		previewChars?: number;
	},
): ReflectionBudgetSelection {
	const budgetTokens =
		Number.isFinite(options.budgetTokens) && options.budgetTokens > 0
			? options.budgetTokens
			: DEFAULT_REFLECTIONS_BUDGET_TOKENS;
	const indexTokens =
		Number.isFinite(options.indexTokens) && options.indexTokens > 0
			? options.indexTokens
			: DEFAULT_REFLECTIONS_INDEX_TOKENS;
	const previewChars = options.previewChars ?? REFLECTION_INDEX_PREVIEW_CHARS;

	const protectedIds = options.protectedIds ?? new Set<string>();
	const chosen = new Set<string>();
	let renderedTokens = 0;

	const consider = (reflection: Reflection): void => {
		if (chosen.has(reflection.id)) return;
		const lineTokens = reflectionLineTokenCount(reflection);
		if (renderedTokens + lineTokens > budgetTokens) return;
		chosen.add(reflection.id);
		renderedTokens += lineTokens;
	};

	for (let i = reflections.length - 1; i >= 0; i--) {
		const reflection = reflections[i];
		if (reflection && protectedIds.has(reflection.id)) consider(reflection);
	}
	for (let i = reflections.length - 1; i >= 0; i--) {
		const reflection = reflections[i];
		if (reflection) consider(reflection);
	}

	const rendered: Reflection[] = [];
	const indexedNewestFirst: ReflectionIndexEntry[] = [];
	let indexedTokens = 0;
	let omittedCount = 0;

	// Walk newest-first as well, so when the index budget runs out the records
	// that fall off are the oldest ones, not the most recent.
	for (let i = reflections.length - 1; i >= 0; i--) {
		const reflection = reflections[i];
		if (!reflection) continue;
		if (chosen.has(reflection.id)) continue;
		const preview = previewReflectionContent(reflection.content, previewChars);
		const lineTokens = reflectionIndexLineTokenCount(reflection, previewChars);
		if (indexedTokens + lineTokens > indexTokens) {
			omittedCount++;
			continue;
		}
		indexedNewestFirst.push({ id: reflection.id, preview });
		indexedTokens += lineTokens;
	}

	for (const reflection of reflections) {
		if (chosen.has(reflection.id)) rendered.push(reflection);
	}
	const indexed = indexedNewestFirst.reverse();

	return { rendered, indexed, omittedCount, renderedTokens, indexedTokens, previewChars };
}