import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_POOL_CEILING_RATIO, DEFAULT_POOL_CEILING_TOKENS } from "./agents/dropper/ceiling.js";
import {
	DEFAULT_REFLECTIONS_BUDGET_RATIO,
	DEFAULT_REFLECTIONS_BUDGET_TOKENS,
	DEFAULT_REFLECTIONS_INDEX_TOKENS,
} from "./session-ledger/reflection-budget.js";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

/**
 * How `compactAfterTokens` is interpreted.
 *
 * - `"calibrated"` (default): use the static `compactAfterTokens` value directly.
 *   Backwards-compatible with all existing V3 configs.
 *
 * - `"ratio"`: compute the effective threshold as
 *   `floor(model.contextWindow * compactAfterTokensRatio)`. This auto-scales the
 *   proactive compaction trigger to the active model's context window, so a 1M
 *   context model is not preempted at the same 81K threshold as a 128K model.
 *
 *   Some models advertise a large context window but lose attention at long
 *   range; users can lower `compactAfterTokensRatio` to compact earlier on such
 *   models without giving up the window on models that stay sharp.
 *
 *   When the active model's `contextWindow` is unavailable (undefined, 0, or
 *   negative), ratio mode falls back to the calibrated `compactAfterTokens`
 *   value so compaction still triggers safely.
 */
export type CompactAfterTokensMode = "calibrated" | "ratio";

export interface Config {
	observeAfterTokens: number;
	reflectAfterTokens: number;
	/**
	 * Maximum estimated source tokens serialized into a single observer chunk.
	 * Unset (default) derives the cap from the resolved memory model's context
	 * window; see {@link resolveObserverChunkMaxTokens}.
	 */
	observerChunkMaxTokens?: number;
	compactAfterTokens: number;
	compactAfterTokensMode: CompactAfterTokensMode;
	compactAfterTokensRatio: number;
	observationsPoolMaxTokens: number;
	observationsPoolTargetTokens: number;
	/**
	 * Upper bound on the active observation pool, above which the eviction
	 * adjudicator stops being able to veto drops (see
	 * {@link import("./agents/dropper/ceiling.js").computeCeilingTokens}).
	 * Separate from `observationsPoolMaxTokens`, which is a compaction
	 * cache-policy trigger with different semantics.
	 */
	observationsPoolCeilingTokens: number;
	/**
	 * Ceiling as a fraction of the active model's context window, applied as an
	 * upper cap on `observationsPoolCeilingTokens` so a small window cannot be
	 * asked to hold a pool that would not fit in it.
	 */
	observationsPoolCeilingRatio: number;
	/**
	 * Token budget for reflections rendered in full in a fold summary. The
	 * observation pool has a ceiling; reflections had no bound at all, and the
	 * rendered reflection list is what pushes a fold summary past half of a
	 * model's context window. Bounds rendering only: every reflection stays in
	 * the ledger and is reachable through the recall tool.
	 */
	reflectionsBudgetTokens: number;
	/**
	 * Full-text reflection budget as a fraction of the active model's context
	 * window, applied as an upper cap on `reflectionsBudgetTokens` so a small
	 * window is not asked to hold a fixed budget it cannot fit.
	 */
	reflectionsBudgetRatio: number;
	/**
	 * Budget for the index tier: reflections that did not fit the full-text
	 * budget are rendered as an id plus a short preview, so the model can see the
	 * record exists and read it with recall. Records past this budget are counted
	 * but not listed.
	 */
	reflectionsIndexTokens: number;
	agentMaxTurns: number;
	/**
	 * Maximum output tokens requested for background memory-agent loops
	 * (observer/reflector/dropper). Always clamped to the model's own
	 * `maxTokens` when available. Lower it for local servers with a modest
	 * context window, where concurrent sub-agent requests share KV with the
	 * main session and the default 32K response budget can overflow the slot.
	 */
	agentMaxTokens: number;
	model?: ConfiguredModel;
	showWorkerNotifications: boolean;
	passive: boolean;
	debugLog: boolean;
}

export const DEFAULTS: Config = {
	observeAfterTokens: 10_000,
	reflectAfterTokens: 20_000,
	compactAfterTokens: 81_000,
	compactAfterTokensMode: "calibrated",
	compactAfterTokensRatio: 0.68,
	observationsPoolMaxTokens: 20_000,
	observationsPoolTargetTokens: 10_000,
	observationsPoolCeilingTokens: DEFAULT_POOL_CEILING_TOKENS,
	observationsPoolCeilingRatio: DEFAULT_POOL_CEILING_RATIO,
	reflectionsBudgetTokens: DEFAULT_REFLECTIONS_BUDGET_TOKENS,
	reflectionsBudgetRatio: DEFAULT_REFLECTIONS_BUDGET_RATIO,
	reflectionsIndexTokens: DEFAULT_REFLECTIONS_INDEX_TOKENS,
	agentMaxTurns: 16,
	agentMaxTokens: 32_000,
	showWorkerNotifications: true,
	passive: false,
	debugLog: false,
};

export const COMPACT_AFTER_TOKENS_MODE_VALUES: readonly CompactAfterTokensMode[] = ["calibrated", "ratio"] as const;

/**
 * Resolve the effective proactive-compaction token threshold for the given
 * config and active model context window.
 *
 * In `"calibrated"` mode this is always `config.compactAfterTokens`.
 *
 * In `"ratio"` mode this is `floor(contextWindow * compactAfterTokensRatio)`
 * (clamped to a minimum of 1) when `contextWindow` is a positive number, and
 * falls back to `config.compactAfterTokens` otherwise.
 */
export function resolveCompactAfterTokens(config: Config, contextWindow: number | undefined): number {
	if (config.compactAfterTokensMode === "ratio" && typeof contextWindow === "number" && contextWindow > 0) {
		return Math.max(1, Math.floor(contextWindow * config.compactAfterTokensRatio));
	}
	return config.compactAfterTokens;
}

export const THINKING_LEVEL_VALUES: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Observer chunk cap used when no config is set and the model's context window is unknown. */
export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000;

/** Smallest useful observer chunk: enough for labels, omission markers, and source context. */
export const OBSERVER_CHUNK_MIN_TOKENS = 256;

/**
 * Fraction of the memory model's context window used for the derived observer
 * chunk cap. Chunk sizes are estimated at ~4 chars/token, which can undercount
 * real tokens by up to ~4x on non-ASCII content, so 0.2 keeps even the worst
 * case at ~80% of the window with room left for the system prompt, prior
 * memory, and the response.
 */
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;

/**
 * Resolve the maximum estimated tokens the observer serializes into one chunk.
 *
 * An explicit `observerChunkMaxTokens` config value always wins. Otherwise the
 * cap is `floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO)` for the resolved
 * memory model, falling back to {@link OBSERVER_CHUNK_FALLBACK_MAX_TOKENS} when
 * the context window is unavailable.
 *
 * Without a cap, a backlog that outgrows the model's context window (e.g.
 * after repeated observer failures, or when the extension is enabled mid-way
 * into a long session) makes every observer call fail, so coverage never
 * advances and the session can never recover. With the cap, oversized backlogs
 * are drained oldest-first across successive runs.
 */
export function resolveObserverChunkMaxTokens(config: Config, contextWindow: number | undefined): number {
	if (config.observerChunkMaxTokens !== undefined && config.observerChunkMaxTokens > 0) {
		return Math.max(OBSERVER_CHUNK_MIN_TOKENS, config.observerChunkMaxTokens);
	}
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(
			OBSERVER_CHUNK_MIN_TOKENS,
			Math.floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO),
		);
	}
	return OBSERVER_CHUNK_FALLBACK_MAX_TOKENS;
}

const SETTINGS_KEY = "observational-memory";
const PASSIVE_ENV = "PI_OBSERVATIONAL_MEMORY_PASSIVE";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

function validTargetOrUndefined(value: unknown, maxTokens: number): number | undefined {
	const target = positiveIntegerOrUndefined(value);
	return target !== undefined && target < maxTokens ? target : undefined;
}

function derivedObservationPoolTarget(maxTokens: number): number {
	return Math.floor(maxTokens / 2);
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(value);
}

function isCompactAfterTokensMode(value: unknown): value is CompactAfterTokensMode {
	return typeof value === "string" && (COMPACT_AFTER_TOKENS_MODE_VALUES as readonly string[]).includes(value);
}

/**
 * A valid ratio is a finite number strictly between 0 and 1.
 * 0 would never trigger; >= 1 would compact at/after the full window with no
 * room left for the response.
 */
function validRatioOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeModel(value: unknown): ConfiguredModel | undefined {
	if (!isRecord(value)) return undefined;
	const provider = nonEmptyString(value.provider);
	const id = nonEmptyString(value.id);
	if (!provider || !id) return undefined;
	const model: ConfiguredModel = { provider, id };
	if (isThinkingLevel(value.thinking)) model.thinking = value.thinking;
	return model;
}

function normalizeSettingsConfig(value: Record<string, unknown>): Partial<Config> {
	const normalized: Partial<Config> = {};
	const numberKeys = [
		"observeAfterTokens",
		"reflectAfterTokens",
		"observerChunkMaxTokens",
		"compactAfterTokens",
		"observationsPoolMaxTokens",
		"observationsPoolTargetTokens",
		"observationsPoolCeilingTokens",
		"reflectionsBudgetTokens",
		"reflectionsIndexTokens",
		"agentMaxTurns",
		"agentMaxTokens",
	] as const;
	for (const key of numberKeys) {
		const normalizedValue = positiveIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	if (isCompactAfterTokensMode(value.compactAfterTokensMode)) {
		normalized.compactAfterTokensMode = value.compactAfterTokensMode;
	}
	const ratio = validRatioOrUndefined(value.compactAfterTokensRatio);
	if (ratio !== undefined) normalized.compactAfterTokensRatio = ratio;
	const ceilingRatio = validRatioOrUndefined(value.observationsPoolCeilingRatio);
	if (ceilingRatio !== undefined) normalized.observationsPoolCeilingRatio = ceilingRatio;
	const reflectionsRatio = validRatioOrUndefined(value.reflectionsBudgetRatio);
	if (reflectionsRatio !== undefined) normalized.reflectionsBudgetRatio = reflectionsRatio;
	if (typeof value.showWorkerNotifications === "boolean") normalized.showWorkerNotifications = value.showWorkerNotifications;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
	const model = normalizeModel(value.model);
	if (model) normalized.model = model;
	return normalized;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawPassive = env[PASSIVE_ENV];
	if (rawPassive === undefined) return {};
	const passive = rawPassive.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
	if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
	return {};
}

function readNamespacedConfig(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const nested = raw[SETTINGS_KEY];
		return isRecord(nested) ? normalizeSettingsConfig(nested) : {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	const globalConfig = readNamespacedConfig(globalPath);
	const projectConfig = readNamespacedConfig(projectPath);
	const envConfig = readEnvConfig(env);
	const merged = {
		...DEFAULTS,
		observationsPoolTargetTokens: undefined,
		...globalConfig,
		...projectConfig,
		...envConfig,
	};
	const target = validTargetOrUndefined(
		merged.observationsPoolTargetTokens,
		merged.observationsPoolMaxTokens,
	) ?? derivedObservationPoolTarget(merged.observationsPoolMaxTokens);

	return {
		...merged,
		observationsPoolTargetTokens: target,
	};
}
