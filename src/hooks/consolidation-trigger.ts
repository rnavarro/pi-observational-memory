import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runAdjudicator } from "../agents/adjudicator/agent.js";
import { runDropper } from "../agents/dropper/agent.js";
import { computeCeilingTokens, poolCeilingMetrics, selectCeilingEvictions, CEILING_OVERRIDE_RATIONALE } from "../agents/dropper/ceiling.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { planEvictionBatch } from "./eviction-batch.js";
import { ObserverStreamError, runObserver } from "../agents/observer/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveObserverChunkMaxTokens } from "../config.js";
import type { ResolveResult, Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedDataStrict,
	buildObservationsRecordedData,
	buildReflectionsRecordedData,
	earlierCoverageMarkerId,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	observationToSummaryLine,
	realTokensSinceAnchor,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	reflectionToSummaryLine,
	type Entry,
	type Observation,
	type Reflection,
	type V3MemoryCustomType,
} from "../session-ledger/index.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
	getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined;
	sessionManager: {
		getBranch: () => unknown;
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

type StageOutcome = "continue" | "abort";

type ReflectorStageResult = {
	outcome: StageOutcome;
	sameRunReflections: Reflection[];
	effectiveReflectionCoverageId?: string;
};

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
}

function mergeReflections(existing: Reflection[], additional: Reflection[]): Reflection[] {
	const seen = new Set(existing.map((reflection) => reflection.id));
	const merged = [...existing];
	for (const reflection of additional) {
		if (seen.has(reflection.id)) continue;
		seen.add(reflection.id);
		merged.push(reflection);
	}
	return merged;
}

/**
 * Real current context tokens from the session (provider-reported usage, the
 * same basis the footer percentage uses). Falls back to undefined when the
 * host pi lacks getContextUsage or the count is unknown (e.g. right after a
 * compaction, before the next valid assistant response).
 */
function realContextTokens(ctx: ConsolidationCtx): number | undefined {
	const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
	const tokens = usage?.tokens;
	return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined;
}

function stageDue(
	entries: Entry[],
	runtime: Runtime,
	currentTokens: number | undefined,
	customType: V3MemoryCustomType,
	rawEstimateFn: (entries: Entry[]) => number,
	threshold: number,
): boolean {
	if (currentTokens !== undefined) {
		const real = realTokensSinceAnchor(entries, customType, currentTokens);
		if (real !== undefined) return real >= threshold;
	}
	// Real delta unmeasurable (no usage baseline, or accounting basis changed) or
	// old pi host without getContextUsage — fall back to the raw estimate, which
	// self-limits after coverage and cannot over-fire or starve.
	return rawEstimateFn(entries) >= threshold;
}

function anyStageDue(entries: Entry[], runtime: Runtime, currentTokens: number | undefined): boolean {
	return stageDue(entries, runtime, currentTokens, OM_OBSERVATIONS_RECORDED, rawTokensSinceObservationCoverage, runtime.config.observeAfterTokens)
		|| stageDue(entries, runtime, currentTokens, OM_REFLECTIONS_RECORDED, rawTokensSinceReflectionCoverage, runtime.config.reflectAfterTokens);
}

/**
 * The effective pool ceiling for this session.
 *
 * The folded pool is rendered into the compaction summary that the session model
 * reads, so the session model's window is the binding constraint, not the memory
 * worker's.
 */
function resolveCeilingTokens(runtime: Runtime, ctx: ConsolidationCtx): number {
	return computeCeilingTokens({
		contextWindow: (ctx.model as { contextWindow?: number } | undefined)?.contextWindow,
		fixedTokens: runtime.config.observationsPoolCeilingTokens,
		ratio: runtime.config.observationsPoolCeilingRatio,
		targetTokens: runtime.config.observationsPoolTargetTokens,
	});
}

function poolOverCeiling(entries: Entry[], runtime: Runtime, ctx: ConsolidationCtx): boolean {
	if (!latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED)) return false;
	const folded = foldLedger(entries);
	return poolCeilingMetrics(folded.activeObservations, resolveCeilingTokens(runtime, ctx)).overCeiling;
}

function shouldNotifyWorker(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return runtime.config.showWorkerNotifications && ctx.hasUI;
}

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): (stage: "observer" | "reflector" | "dropper") => Promise<ResolvedModel | undefined> {
	let cached: ResolveResult | undefined;
	return async (stage) => {
		cached ??= await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (cached.ok) {
			runtime.resolveFailureNotified = false;
			// Console Go (opencode.ai) rejects requests without x-opencode-session
			// (400 MissingSessionID). Mirror pi's own session headers on worker calls.
			const model = (cached.model ?? {}) as { provider?: string; baseUrl?: string };
			if (model.provider === "opencode" || model.provider === "opencode-go" || (typeof model.baseUrl === "string" && model.baseUrl.includes("opencode.ai"))) {
				const sessionId = ctx.sessionManager.getSessionId?.();
				if (sessionId) {
					return {
						...cached,
						headers: {
							...(cached.headers ?? {}),
							"x-opencode-session": sessionId,
							"x-opencode-client": "pi",
						},
					};
				}
			}
			return cached;
		}
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`Observational memory: ${stage} skipped — ${cached.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = (_event: unknown, ctx: ConsolidationCtx) => {
		maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("agent_start", launch);
	pi.on("turn_end", launch);
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string; sessionFile?: string } {
	try {
		return {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionFile: ctx.sessionManager.getSessionFile?.(),
		};
	} catch {
		return {};
	}
}

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return;
	if (runtime.consolidationInFlight) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const stageDue = anyStageDue(entries, runtime, realContextTokens(ctx));
	// Pool pressure is a launch condition in its own right: without it a pool that
	// outgrew its ceiling while both model-stage clocks are quiet would never be
	// checked, because ceiling enforcement only runs inside a launched pipeline.
	// The `&&` short-circuits so the extra fold happens only when no stage is due.
	if (!stageDue && !poolOverCeiling(entries, runtime, ctx)) return;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		getContextUsage: ctx.getContextUsage,
		sessionManager: ctx.sessionManager,
	};

	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
}

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
): Promise<void> {
	const resolveModel = makeModelResolver(runtime, ctx);
	await runModelStages(pi, runtime, ctx, resolveModel);

	// Ceiling enforcement runs after every model stage and independently of them.
	// It is the only bound that still holds when a stage aborted, threw, or
	// proposed nothing at all, so it must not live inside the dropper.
	runtime.consolidationPhase = "ceiling";
	try {
		runCeilingEnforcementStage(pi, runtime, ctx);
	} catch (error) {
		debugLog("ceiling.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "ceiling", error) });
	}
}

/**
 * The model-driven stages, in order. Each stage re-checks its own threshold, so a
 * launch triggered only by pool pressure still makes no model calls.
 */
async function runModelStages(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "observer" | "reflector" | "dropper") => Promise<ResolvedModel | undefined>,
): Promise<void> {
	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel);
		if (observerOutcome === "abort") return;
	} catch (error) {
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}

	runtime.consolidationPhase = "reflector";
	let reflectorResult: ReflectorStageResult;
	try {
		reflectorResult = await runReflectorStage(pi, runtime, ctx, resolveModel);
		if (reflectorResult.outcome === "abort") return;
	} catch (error) {
		debugLog("reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
		return;
	}

	runtime.consolidationPhase = "dropper";
	try {
		await runDropperStage(pi, runtime, ctx, resolveModel, reflectorResult.sameRunReflections, reflectorResult.effectiveReflectionCoverageId);
	} catch (error) {
		debugLog("dropper.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error) });
	}
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const currentTokens = realContextTokens(ctx);
	const real = currentTokens !== undefined ? realTokensSinceAnchor(entries, OM_OBSERVATIONS_RECORDED, currentTokens) : undefined;
	const tokens = real !== undefined ? real : rawTokensSinceObservationCoverage(entries); // fallback: no usage baseline / basis change
	if (tokens < runtime.config.observeAfterTokens) return "continue";

	const sessionMetadata = debugSessionMetadata(ctx);
	const sessionIdentity = sessionMetadata.sessionId ?? sessionMetadata.sessionFile;
	const coverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);

	// Deliberate-empty backoff (#23): an intentional "nothing to record" verdict
	// must not re-fire the observer every turn over the same span. Retry only
	// after another observeAfterTokens worth of new source tokens arrives, and
	// drop the backoff as soon as coverage advances.
	const backoff = runtime.observerEmptyBackoff;
	if (backoff) {
		if (
			sessionIdentity !== backoff.sessionIdentity
			|| coverageId !== backoff.coverageId
			|| tokens >= backoff.tokensAtEmpty + runtime.config.observeAfterTokens
		) {
			runtime.observerEmptyBackoff = undefined;
		} else {
			debugLog("observer.empty_backoff", { tokens, resumeAtTokens: backoff.tokensAtEmpty + runtime.config.observeAfterTokens });
			return "continue";
		}
	}

	// Resolve the model before building the chunk: the default chunk cap
	// derives from the resolved model's context window.
	const resolved = await resolveModel("observer");
	if (!resolved) return "abort";

	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const backlogEntries = sourceEntriesAfter(entries, lastCoverageIdx);

	// Budget the text that is actually sent to the observer, including source
	// labels and rendered message content. Complete entries are kept intact.
	// Only a first entry that cannot fit by itself is represented by a clearly
	// marked head/tail excerpt; the original ledger entry remains untouched.
	const contextWindow = (resolved.model as { contextWindow?: number }).contextWindow;
	const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
	const {
		text: chunk,
		sourceEntryIds,
		estimatedTokens: chunkTokens,
		truncatedSourceEntryIds,
	} = serializeSourceAddressedBranchEntries(backlogEntries, { maxTokens: maxChunkTokens });
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";
	const coversUpToId = sourceEntryIds.at(-1);
	if (!coversUpToId) return "continue";

	if (sourceEntryIds.length < backlogEntries.length || truncatedSourceEntryIds.length > 0) {
		debugLog("observer.chunk_capped", {
			maxChunkTokens,
			backlogEntries: backlogEntries.length,
			backlogTokens: tokens,
			chunkEntries: sourceEntryIds.length,
			chunkTokens,
			truncatedSourceEntryIds,
		});
	}

	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk`,
		"info",
	);
	debugLog("observer.start", {
		tokens,
		chunkTokens,
		coversUpToId,
		sourceEntryIds,
		sourceEntryCount: sourceEntryIds.length,
		priorReflections: priorReflections.length,
		priorObservations: priorObservations.length,
	});

	let observations: Observation[] | undefined;
	try {
		observations = await runObserver({
			model: resolved.model as any,
			apiKey: resolved.apiKey,
			headers: resolved.headers,
			env: resolved.env,
			priorReflections,
			priorObservations,
			chunk,
			allowedSourceEntryIds: sourceEntryIds,
			maxTurns: runtime.config.agentMaxTurns,
			maxOutputTokens: runtime.config.agentMaxTokens,
			thinkingLevel: runtime.config.model?.thinking ?? "low",
			modelRegistry: ctx.modelRegistry,
		});
	} catch (error) {
		if (error instanceof ObserverStreamError) {
			// API/stream failure is not a clean empty (#32): surface it as a real
			// failure instead of the "no observations" path. Coverage stays put.
			runtime.recordConsolidationStageError(ctx, "observer", error);
			return "abort";
		}
		throw error;
	}
	if (!observations || observations.length === 0) {
		// Deliberate empty: routine info, not a warning, and back off re-fires
		// over the same span (#23).
		debugLog("observer.empty", { coversUpToId });
		runtime.observerEmptyBackoff = { sessionIdentity, coverageId, tokensAtEmpty: tokens };
		if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
			"Observational memory: observer found nothing new in this chunk (coverage unchanged; will retry later)",
			"info",
		);
		return "continue";
	}
	runtime.observerEmptyBackoff = undefined;

	const data = buildObservationsRecordedData(observations, coversUpToId);
	if (!data) return "continue";
	debugLog("observer.records", {
		count: observations.length,
		observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
		coversUpToId,
	});
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	debugLog("observer.appended", { count: observations.length, coversUpToId });
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
		"info",
	);
	return "continue";
}

async function runReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "reflector") => Promise<ResolvedModel | undefined>,
): Promise<ReflectorStageResult> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const currentTokens = realContextTokens(ctx);
	const real = currentTokens !== undefined ? realTokensSinceAnchor(entries, OM_REFLECTIONS_RECORDED, currentTokens) : undefined;
	const reflectionTokens = real !== undefined ? real : rawTokensSinceReflectionCoverage(entries); // fallback: no usage baseline / basis change
	if (reflectionTokens < runtime.config.reflectAfterTokens) return { outcome: "continue", sameRunReflections: [] };

	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return { outcome: "continue", sameRunReflections: [] };

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: reflector running (~${reflectionTokens.toLocaleString()} tokens)`,
		"info",
	);
	const resolved = await resolveModel("reflector");
	if (!resolved) return { outcome: "abort", sameRunReflections: [] };

	const folded = foldLedger(entries);
	const reflections = await runReflector({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		env: resolved.env,
		reflections: folded.reflections,
		observations: folded.activeObservations,
		maxTurns: runtime.config.agentMaxTurns,
		maxOutputTokens: runtime.config.agentMaxTokens,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
		modelRegistry: ctx.modelRegistry,
	});
	if (!reflections) return { outcome: "continue", sameRunReflections: [] };

	const data = buildReflectionsRecordedData(reflections, observationCoverageId);
	if (!data) return { outcome: "continue", sameRunReflections: [] };
	appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
	return {
		outcome: "continue",
		sameRunReflections: reflections,
		effectiveReflectionCoverageId: data.coversUpToId,
	};
}

async function runDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "dropper") => Promise<ResolvedModel | undefined>,
	sameRunReflections: Reflection[],
	sameRunReflectionCoverageId: string | undefined,
): Promise<StageOutcome> {
	if (!sameRunReflectionCoverageId || sameRunReflections.length === 0) {
		debugLog("dropper.waiting_for_reflection", { sameRunReflections: sameRunReflections.length });
		return "continue";
	}

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return "continue";

	const folded = foldLedger(entries);
	const metrics = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
	const ceilingNow = poolCeilingMetrics(folded.activeObservations, resolveCeilingTokens(runtime, ctx));
	if (!metrics.ready) {
		debugLog("dropper.not_ready", {
			observationTokens: metrics.observationTokens,
			targetTokens: metrics.targetTokens,
			tokensOverTarget: metrics.tokensOverTarget,
			fullness: metrics.fullness,
			activeObservationCount: metrics.activeObservationCount,
			droppableCount: metrics.droppableCount,
			maxDropsAllowed: metrics.maxDropsAllowed,
		});
		return "continue";
	}
	debugLog("dropper.stage_start", {
		observationCoverageId,
		sameRunReflectionCoverageId,
		sameRunReflectionCount: sameRunReflections.length,
		activeObservationCount: metrics.activeObservationCount,
		observationTokens: metrics.observationTokens,
		targetTokens: metrics.targetTokens,
		tokensOverTarget: metrics.tokensOverTarget,
		fullness: metrics.fullness,
		maxDropsAllowed: metrics.maxDropsAllowed,
		// Carried alongside the target numbers so the distance to the hard limit is
		// visible on the same line as the pressure that engaged the dropper. The
		// target is the compaction policy knob; the ceiling is the bound.
		ceilingTokens: ceilingNow.ceilingTokens,
		ceilingHeadroomTokens: ceilingNow.ceilingTokens - ceilingNow.observationTokens,
		overCeiling: ceilingNow.overCeiling,
	});

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: dropper running after reflection — active observation pool ~${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens (${Math.round(metrics.fullness * 100).toLocaleString()}%)`,
		"info",
	);
	const resolved = await resolveModel("dropper");
	if (!resolved) return "abort";

	const reflectionsForDropper = mergeReflections(folded.reflections, sameRunReflections);
	const droppedIds = await runDropper({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		env: resolved.env,
		reflections: reflectionsForDropper,
		observations: folded.activeObservations,
		targetTokens: runtime.config.observationsPoolTargetTokens,
		maxTurns: runtime.config.agentMaxTurns,
		maxOutputTokens: runtime.config.agentMaxTokens,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
		modelRegistry: ctx.modelRegistry,
	});
	// The adjudicator decides whether each proposed removal is actually safe.
	// It runs on the same resolved worker model as the other stages.
	const observationById = new Map(folded.activeObservations.map((observation) => [observation.id, observation]));
	const candidates = (droppedIds ?? []).flatMap((id) => {
		const observation = observationById.get(id);
		return observation ? [observation] : [];
	});
	const adjudication =
		candidates.length > 0
			? await runAdjudicator({
					model: resolved.model as any,
					apiKey: resolved.apiKey,
					headers: resolved.headers,
					env: resolved.env,
					candidates,
					reflections: reflectionsForDropper,
					maxTurns: runtime.config.agentMaxTurns,
					maxOutputTokens: runtime.config.agentMaxTokens,
					thinkingLevel: runtime.config.model?.thinking ?? "low",
					modelRegistry: ctx.modelRegistry,
				})
			: undefined;

	// The ceiling is the operational hard limit that keeps a run of `keep` verdicts
	// from letting the pool grow without bound; the batch planner is candidate-local
	// and the standalone ceiling stage handles the pool-wide case.
	const plan = planEvictionBatch({
		candidates,
		decisions: adjudication?.decisions ?? [],
		distilled: adjudication?.distilled ?? [],
		currentReflectionIds: reflectionsForDropper.map((reflection) => reflection.id),
	});

	const coversUpToId = earlierCoverageMarkerId(entries, observationCoverageId, sameRunReflectionCoverageId);
	// Distilled reflections must be in the ledger before the drop that relies on
	// them, so the observation's meaning survives its own eviction. Reusing the
	// reflector's coverage marker keeps both coverage clocks unchanged while
	// still making these reflections visible to the next projection.
	const distilledData = plan.distilled.length > 0
		? buildReflectionsRecordedData(plan.distilled, sameRunReflectionCoverageId)
		: undefined;
	if (distilledData) appendEntry(pi, OM_REFLECTIONS_RECORDED, distilledData);

	const data = coversUpToId
		? buildObservationsDroppedDataStrict(plan.droppedIds, coversUpToId, {
			mode: "adjudicated",
			decisions: plan.decisions,
			survivingReflectionIds: new Set(plan.survivingReflectionIds),
			distilledReflectionIdForObservation: plan.distilledReflectionIdForObservation,
		})
		: undefined;
	debugLog("dropper.append", {
		proposedIdsCount: droppedIds?.length ?? 0,
		droppedIdsCount: plan.droppedIds.length,
		keptCount: plan.keptIds.length,
		distilledCount: plan.distilled.length,
		coversUpToId,
		dataBuilt: data !== undefined,
		appended: data !== undefined,
	});
	if (data) appendEntry(pi, OM_OBSERVATIONS_DROPPED, data);
	return "continue";
}

/**
 * Deterministic pool-ceiling enforcement.
 *
 * This is the only place allowed to evict observations the dropper never
 * proposed, and it is the only bound that survives the model stages failing. The
 * dropper waits for a fresh reflection batch and the batch planner can only
 * commit what the dropper proposed, so neither can bound a pool on its own: an
 * aborted stage, a stage error, or an empty proposal would all leave the pool
 * above its ceiling. This stage needs no model, so it always runs.
 *
 * Policy: lowest relevance first, then oldest, taking only as many records as
 * needed to return under the ceiling. Every eviction records an explicit `retire`
 * decision carrying the ceiling rationale, so policy-authorised loss stays
 * auditable rather than silent.
 *
 * This is an availability-first policy, stated rather than implied: under
 * capacity pressure the alternative is a preserve-first state that blocks
 * further model work until memory is resolved, and wedging the assistant is a
 * worse default here than bounded, attributed, user-visible loss. Because it
 * overrides `keep`, the adjudicator's preservation floor is capacity-conditional
 * rather than absolute, and the warning below is what makes that visible instead
 * of silent.
 */
function runCeilingEnforcementStage(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return;

	const folded = foldLedger(entries);
	const ceilingTokens = resolveCeilingTokens(runtime, ctx);
	const ceiling = poolCeilingMetrics(folded.activeObservations, ceilingTokens);
	// A pressure reading is logged whenever the pool is over its target, not only
	// when it is evicted: enforcement is the last resort, and the interesting
	// question is how close the pool came to it, which stays invisible if only the
	// eviction is logged. Over-target is the condition under which the dropper is
	// engaged at all, so this stays quiet while the pool is comfortable.
	if (ceiling.observationTokens > runtime.config.observationsPoolTargetTokens) {
		debugLog("pool.ceiling_pressure", {
			observationTokens: ceiling.observationTokens,
			ceilingTokens: ceiling.ceilingTokens,
			headroomTokens: ceiling.ceilingTokens - ceiling.observationTokens,
			targetTokens: runtime.config.observationsPoolTargetTokens,
			overCeiling: ceiling.overCeiling,
			activeObservationCount: folded.activeObservations.length,
		});
	}
	if (!ceiling.overCeiling) return;

	const evictedIds = selectCeilingEvictions(folded.activeObservations, ceiling.tokensOverCeiling);
	if (evictedIds.length === 0) return;
	// Capacity loss is the one path that can take material the adjudicator asked to
	// keep, so its profile is recorded: how many tokens it took and from which
	// relevance tiers. Without this the eviction count alone cannot distinguish
	// reclaiming stale low-relevance records from losing protected ones.
	const evictedObservationById = new Map(folded.activeObservations.map((observation) => [observation.id, observation]));
	const evictedRelevanceCounts: Record<string, number> = {};
	let evictedTokens = 0;
	for (const id of evictedIds) {
		const observation = evictedObservationById.get(id);
		evictedTokens += observation?.tokenCount ?? 0;
		const relevance = observation?.relevance ?? "unknown";
		evictedRelevanceCounts[relevance] = (evictedRelevanceCounts[relevance] ?? 0) + 1;
	}

	const coversUpToId = earlierCoverageMarkerId(entries, observationCoverageId, undefined);
	const data = coversUpToId
		? buildObservationsDroppedDataStrict(evictedIds, coversUpToId, {
				mode: "ceiling",
				decisions: evictedIds.map((id) => ({ id, outcome: "retire" as const, rationale: CEILING_OVERRIDE_RATIONALE })),
			})
		: undefined;
	if (data) {
		// Capacity loss is not an adjudicated retirement, so it gets a visible
		// warning rather than only a debug-log line: the user is the one who can
		// act on it (smaller window, fewer retained records), and this is the only
		// path that can evict observations the adjudicator asked to keep.
		ctx.ui?.notify(
			`Observational memory: pool over ceiling — evicted ${evictedIds.length} observation${evictedIds.length === 1 ? "" : "s"} for capacity (not adjudicated)`,
			"warning",
		);
	}
	debugLog("dropper.ceiling_enforced", {
		observationTokens: ceiling.observationTokens,
		ceilingTokens: ceiling.ceilingTokens,
		tokensOverCeiling: ceiling.tokensOverCeiling,
		evictedIdsCount: evictedIds.length,
		evictedTokens,
		evictedRelevanceCounts,
		activeObservationCount: folded.activeObservations.length,
		coversUpToId,
		appended: data !== undefined,
	});
	if (data) appendEntry(pi, OM_OBSERVATIONS_DROPPED, data);
}
