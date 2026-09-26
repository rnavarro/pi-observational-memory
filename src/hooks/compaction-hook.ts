import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import type { Runtime } from "../runtime.js";
import { debugLog } from "../debug-log.js";
import {
	buildCompactionProjection,
	computeReflectionsBudgetTokens,
	DEFAULT_REFLECTIONS_BUDGET_RATIO,
	DEFAULT_REFLECTIONS_BUDGET_TOKENS,
	DEFAULT_REFLECTIONS_INDEX_TOKENS,
	renderSummary,
	type Entry,
} from "../session-ledger/index.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

function positiveNumberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Resolve the reflection rendering budgets. The full-text budget is capped by a
 * fraction of the active model's context window so a small window is not asked
 * to hold a fixed budget it cannot fit; the ratio is only applied when a window
 * is known.
 */
function reflectionBudgets(runtime: Runtime, ctx: ExtensionContext): { budgetTokens: number; indexTokens: number } {
	const config = runtime.config as {
		reflectionsBudgetTokens?: unknown;
		reflectionsBudgetRatio?: unknown;
		reflectionsIndexTokens?: unknown;
	};
	const contextWindow = (ctx.model as { contextWindow?: number } | undefined)?.contextWindow;
	const ratio = positiveNumberOr(config.reflectionsBudgetRatio, DEFAULT_REFLECTIONS_BUDGET_RATIO);
	// The same ratio caps both tiers, so a small window shrinks the whole reflected
	// payload rather than only its full-text half.
	return {
		budgetTokens: computeReflectionsBudgetTokens({
			contextWindow,
			fixedTokens: positiveNumberOr(config.reflectionsBudgetTokens, DEFAULT_REFLECTIONS_BUDGET_TOKENS),
			ratio,
		}),
		indexTokens: computeReflectionsBudgetTokens({
			contextWindow,
			fixedTokens: positiveNumberOr(config.reflectionsIndexTokens, DEFAULT_REFLECTIONS_INDEX_TOKENS),
			ratio,
		}),
	};
}
/** MCR (Model Context Recurrence) models handle compaction server-side.
 *  Cancel client-side compaction early to avoid wasted LLM summary work.
 *  This is a safety net — the compaction-trigger also skips MCR models — but
 *  compaction can be triggered by other paths (Pi's built-in threshold, other
 *  extensions calling ctx.compact()). */
function isMCRModel(modelId: string): boolean {
	return modelId.includes("neuralwatt/") || modelId.endsWith("-long") || modelId.endsWith("-mcr");
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		// MCR models: server handles compaction, cancel immediately.
		const modelId = ctx.model?.id || "";
		if (isMCRModel(modelId)) {
			return { cancel: true };
		}

		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Observational memory: another compaction is already in progress; cancelling duplicate",
					"warning",
				);
			}
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const { preparation, branchEntries } = event;
			const { firstKeptEntryId, tokensBefore } = preparation;
			const budgets = reflectionBudgets(runtime, ctx);
			const projection = buildCompactionProjection(
				branchEntries as Entry[],
				firstKeptEntryId,
				{
					observationsPoolMaxTokens: observationsPoolMaxTokens(runtime),
					reflectionsBudgetTokens: budgets.budgetTokens,
					reflectionsIndexTokens: budgets.indexTokens,
				},
			);
			const budget = projection.reflectionBudget;
			const summary = renderSummary(projection.reflections, projection.observations, {
				indexed: budget?.indexed,
				omittedCount: budget?.omittedCount,
			});
			if (budget) {
				debugLog("fold.reflection_budget", {
					renderedCount: budget.rendered.length,
					renderedTokens: budget.renderedTokens,
					budgetTokens: budgets.budgetTokens,
					indexedCount: budget.indexed.length,
					indexedTokens: budget.indexedTokens,
					indexTokens: budgets.indexTokens,
					omittedCount: budget.omittedCount,
					extraReflectionTokens: budgets.budgetTokens - budget.renderedTokens,
				});
			}
			if (budget && budget.omittedCount > 0 && ctx.hasUI) {
				ctx.ui.notify(
					`Observational memory: ${budget.omittedCount} reflection${budget.omittedCount === 1 ? "" : "s"} did not fit this fold and are no longer shown. They stay in the ledger and are readable with recall when an id is known.`,
					"warning",
				);
			}
			if (summary.length === 0) {
				// Decline ownership so Pi's native summarizer preserves the pre-cut context.
				return;
			}

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
