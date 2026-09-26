import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { hashId } from "../../ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { MAX_RECORD_CONTENT_CHARS, truncateRecordContent } from "../../serialize.js";
import { estimateStringTokens } from "../../tokens.js";
import { logAgentStreamError } from "../stream-errors.js";
import { resolveWorkerStreamSimple, type StreamableModelRegistry, type WorkerStreamSimple } from "../worker-stream.js";
import { reflectionToSummaryLine, type Observation, type Reflection } from "../../session-ledger/index.js";
import { coverageTierForObservation, reflectionCoverageMap, observationToDropperLine } from "../dropper/coverage.js";
import { ADJUDICATOR_SYSTEM } from "./prompts.js";
import { extractAnchors } from "./anchors.js";
import {
	ANCHOR_SAMPLE_LIMIT,
	buildAdjudicationMetrics,
	classifyUnknownSupersessionId,
	createAnchorTallies,
	sumReflectionTokens,
	type AnchorMissingSampleEntry,
} from "./metrics.js";

interface RunAdjudicatorArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	/** Observations the dropper selected for removal, in drop order. */
	candidates: Observation[];
	/** Reflections that survive this batch; `replace` may only name one of these. */
	reflections: Reflection[];
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	maxOutputTokens?: number;
	thinkingLevel?: ModelThinkingLevel;
	modelRegistry?: StreamableModelRegistry;
	streamSimple?: WorkerStreamSimple;
}

export type AdjudicationOutcome = "keep" | "retire" | "replace" | "distill";

export type AdjudicationDecision = {
	id: string;
	outcome: AdjudicationOutcome;
	replacementReflectionId?: string;
	/** Structured supersession evidence for `retire`; see `DropDecision`. */
	supersededById?: string;
	rationale?: string;
};

export type AdjudicationResult = {
	/** Exactly one decision per candidate, in candidate order. */
	decisions: AdjudicationDecision[];
	/** New reflections the caller must persist before the drops commit. */
	distilled: Reflection[];
	keptIds: string[];
	retiredIds: string[];
	replacedIds: string[];
	distilledIds: string[];
};

const DecideEvictionsSchema = Type.Object({
	decisions: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1 }),
			outcome: Type.Union([
				Type.Literal("keep"),
				Type.Literal("retire"),
				Type.Literal("replace"),
				Type.Literal("distill"),
			]),
			replacementReflectionId: Type.Optional(Type.String({ minLength: 1 })),
			supersededById: Type.Optional(Type.String({ minLength: 1 })),
			distilledContent: Type.Optional(Type.String({ minLength: 1 })),
			rationale: Type.Optional(Type.String()),
		}),
		{ minItems: 1 },
	),
});

type DecideEvictionsArgs = Static<typeof DecideEvictionsSchema>;

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

function normalizeReflectionContent(content: string | undefined): string | undefined {
	if (!content) return undefined;
	const normalized = content.trim();
	if (!normalized || /\r|\n/.test(normalized)) return undefined;
	// A distillation authorises an irreversible drop, so it must never be lossily
	// truncated: content past the record limit is rejected outright and the
	// candidate is kept, rather than authorising a drop against a representation
	// that may have discarded the load-bearing detail.
	if (normalized.length > MAX_RECORD_CONTENT_CHARS) return undefined;
	return normalized;
}

function normalizeRationale(rationale: string | undefined): string | undefined {
	if (!rationale) return undefined;
	const normalized = truncateRecordContent(rationale.trim());
	return normalized || undefined;
}

/**
 * Adjudicate an eviction batch: for every observation the dropper proposed for
 * removal, decide whether it may actually go.
 *
 * The default is KEEP and it is enforced here rather than requested in the
 * prompt: any candidate without a valid decision is returned as `keep`. The
 * caller therefore cannot drop an observation merely because the model stayed
 * silent, which is the failure mode that prompt-only preservation floors
 * (see dropper/prompts.ts) already demonstrated.
 *
 * `distill` is the write-then-shred path: the adjudicator authors the surviving
 * meaning itself, and the returned `distilled` reflections must be persisted
 * before the corresponding drops are committed. When a distillation is
 * byte-identical to an existing reflection, the decision is downgraded to
 * `replace` naming that reflection instead of duplicating it.
 */
export async function runAdjudicator(args: RunAdjudicatorArgs): Promise<AdjudicationResult | undefined> {
	const { model, apiKey, headers, env, candidates, reflections, signal } = args;
	if (candidates.length === 0) return undefined;
	const startedAt = Date.now();

	const coverageById = reflectionCoverageMap(candidates, reflections);
	const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const existingReflectionById = new Map(reflections.map((reflection) => [reflection.id, reflection.content]));

	const accumulated = new Map<string, AdjudicationDecision>();
	// Candidates the model decided more than once with different outcomes. The
	// safe reading of a contradictory verdict is "keep": a later restatement must
	// never be able to talk its way into an irreversible drop, and it must not be
	// silently discarded either.
	const conflictedIds = new Set<string>();
	// Keyed by the first candidate that produced the content, so same-run
	// duplicate distillations collapse into one reflection with several support ids.
	const distilledById = new Map<string, Reflection>();

	let toolCallCount = 0;
	let rawDecisionCount = 0;
	let unknownCandidateIdCount = 0;
	let duplicateDecisionCount = 0;
	let conflictingDecisionCount = 0;
	let rejectedDecisionCount = 0;
	let replaceWithUnknownReflectionCount = 0;
	let retireWithUnknownSupersessionCount = 0;
	let distillAlreadyReflectedCount = 0;
	let distillMergedIntoExistingCount = 0;

	// Diagnostic only: how often a surviving representation drops a structural
	// anchor the source carried. Deliberately never gates a decision (see
	// anchors.ts), but it makes the omission rate measurable in production.
	// Split by outcome because the two failures mean different things: a
	// distillation is written from the source, so a missing anchor there is an
	// omission, while a replacement may legitimately cover a different part of a
	// multi-fact observation.
	const anchorByOutcome = createAnchorTallies();
	const anchorMissingSample: AnchorMissingSampleEntry[] = [];
	const coverageForCandidate = (candidate: Observation): ReturnType<typeof coverageTierForObservation> =>
		coverageTierForObservation(candidate, coverageById);
	const recordAnchorSurvival = (
		observationId: string,
		outcome: "replace" | "distill",
		survivingContent: string | undefined,
	): void => {
		const source = candidateById.get(observationId);
		if (source === undefined || survivingContent === undefined) return;
		const tally = anchorByOutcome[outcome];
		const anchors = extractAnchors(source.content);
		if (anchors.length === 0) {
			tally.unanchored++;
			return;
		}
		tally.checked++;
		const missing = anchors.filter((anchor) => !survivingContent.includes(anchor));
		if (missing.length === 0) {
			tally.clean++;
			return;
		}
		tally.lossy++;
		if (anchorMissingSample.length < ANCHOR_SAMPLE_LIMIT) {
			anchorMissingSample.push({
				observationId,
				outcome,
				relevance: source.relevance,
				coverage: coverageForCandidate(source),
				missing,
			});
		}
	};

	const decideEvictions: AgentTool<typeof DecideEvictionsSchema> = {
		name: "decide_evictions",
		label: "Decide evictions",
		description:
			"Record a keep, retire, replace, or distill decision for each candidate observation id. Candidates you omit are kept.",
		parameters: DecideEvictionsSchema,
		execute: async (_id, params: DecideEvictionsArgs) => {
			toolCallCount++;
			rawDecisionCount += params.decisions.length;
			let added = 0;
			let rejected = 0;
			const counts: Record<AdjudicationOutcome, number> = { keep: 0, retire: 0, replace: 0, distill: 0 };

			for (const proposal of params.decisions) {
				if (!candidateById.has(proposal.id)) {
					unknownCandidateIdCount++;
					continue;
				}
				// First decision wins, mirroring the reflector's duplicate rejection:
				// a later restatement of the same id must not silently rewrite it.
				if (accumulated.has(proposal.id)) {
					duplicateDecisionCount++;
					if (accumulated.get(proposal.id)?.outcome !== proposal.outcome) {
						conflictingDecisionCount++;
						conflictedIds.add(proposal.id);
					}
					continue;
				}

				if (proposal.outcome === "replace") {
					const replacementReflectionId = proposal.replacementReflectionId;
					if (!replacementReflectionId || !existingReflectionById.has(replacementReflectionId)) {
						replaceWithUnknownReflectionCount++;
						rejectedDecisionCount++;
						rejected++;
						continue;
					}
					accumulated.set(proposal.id, {
						id: proposal.id,
						outcome: "replace",
						replacementReflectionId,
						rationale: normalizeRationale(proposal.rationale),
					});
					recordAnchorSurvival(proposal.id, "replace", existingReflectionById.get(replacementReflectionId));
					counts.replace++;
					added++;
					continue;
				}

				if (proposal.outcome === "distill") {
					const content = normalizeReflectionContent(proposal.distilledContent);
					if (!content) {
						rejectedDecisionCount++;
						rejected++;
						continue;
					}
					// One check covers every distill sub-path: fresh distillation, the
					// existing-reflection downgrade below, and same-run merging.
					recordAnchorSurvival(proposal.id, "distill", content);
					const id = hashId(content);
					if (existingReflectionById.has(id)) {
						// Identical content already exists as a reflection, so an
						// equivalent representation is already preserved: designate it
						// rather than duplicating it.
						accumulated.set(proposal.id, {
							id: proposal.id,
							outcome: "replace",
							replacementReflectionId: id,
							rationale: normalizeRationale(proposal.rationale),
						});
						distillAlreadyReflectedCount++;
						counts.replace++;
						added++;
						continue;
					}
					const existingDistilledReflection = distilledById.get(id);
					if (existingDistilledReflection) {
						// Another candidate already distilled byte-identical content this
						// run: extend that reflection's support ids instead of creating a
						// second reflection with the same hash.
						if (!existingDistilledReflection.supportingObservationIds.includes(proposal.id)) {
							existingDistilledReflection.supportingObservationIds.push(proposal.id);
						}
						distillMergedIntoExistingCount++;
					} else {
						distilledById.set(id, {
							id,
							content,
							supportingObservationIds: [proposal.id],
							tokenCount: estimateStringTokens(content),
						});
					}
					accumulated.set(proposal.id, {
						id: proposal.id,
						outcome: "distill",
						rationale: normalizeRationale(proposal.rationale),
					});
					counts.distill++;
					added++;
					continue;
				}

				// A supersession claim is structured evidence, so an id that does not name a
				// known reflection cannot be checked: keep the candidate rather than commit
				// a drop against an unverifiable claim. Same fail-closed direction as
				// `replace`, and it never parses the prose rationale for ids.
				if (proposal.outcome === "retire" && proposal.supersededById !== undefined && !existingReflectionById.has(proposal.supersededById)) {
					retireWithUnknownSupersessionCount++;
					rejectedDecisionCount++;
					rejected++;
					// Diagnostic only. The rejection is fail-closed, so the decision never
					// reaches the ledger and this is the only place the offending id is
					// recorded. Its shape separates a contract gap (the id names a batch
					// observation or a same-run distillation the validator does not accept)
					// from a model error (the id names nothing), which is what decides
					// whether widening validation would help and by how much.
					debugLog("adjudicator.retire_unknown_supersession", {
						observationId: proposal.id,
						supersededById: proposal.supersededById,
						...classifyUnknownSupersessionId(proposal.supersededById, candidateById, distilledById),
					});
					continue;
				}

				accumulated.set(proposal.id, {
					id: proposal.id,
					outcome: proposal.outcome,
					rationale: normalizeRationale(proposal.rationale),
					...(proposal.outcome === "retire" && proposal.supersededById !== undefined
						? { supersededById: proposal.supersededById }
						: {}),
				});
				counts[proposal.outcome]++;
				added++;
			}

			return {
				content: [
					{
						type: "text",
						text: `Recorded ${added} decision${added === 1 ? "" : "s"}: ${counts.keep} keep, ${counts.retire} retire, ${counts.replace} replace, ${counts.distill} distill. Rejected ${rejected}. Candidates still undecided: ${candidates.length - accumulated.size}.`,
					},
				],
				details: { added, rejected, ...counts, remaining: candidates.length - accumulated.size },
			};
		},
	};

	const userText = `CURRENT REFLECTIONS:\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\nOBSERVATIONS PROPOSED FOR REMOVAL:\n${joinOrEmpty(candidates.map((observation) => observationToDropperLine(observation, coverageTierForObservation(observation, coverageById))))}\n\nAdjudicate each of the ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} above by calling decide_evictions. Candidates you omit are kept.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = { systemPrompt: ADJUDICATOR_SYSTEM, messages: [], tools: [decideEvictions as AgentTool<any>] };
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		env,
		maxTokens: boundedMaxTokens(model, args.maxOutputTokens ?? AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined ? { shouldStopAfterTurn: () => ++turnCount >= effectiveMaxTurns } : {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	// Mirrors dropper.agent_start, so this stage's latency is the gap between the
	// two events rather than being attributed to the dropper that precedes it.
	debugLog("adjudicator.agent_start", {
		candidateCount: candidates.length,
		existingReflectionCount: reflections.length,
		existingReflectionTokens: sumReflectionTokens(reflections),
	});
	const stream = loop(
		prompts,
		context,
		config,
		signal,
		resolveWorkerStreamSimple(model, args.modelRegistry, args.streamSimple),
	);
	for await (const event of stream) {
		logAgentStreamError("adjudicator", event);
	}
	await stream.result();

	const decisions: AdjudicationDecision[] = [];
	const keptIds: string[] = [];
	const retiredIds: string[] = [];
	const replacedIds: string[] = [];
	const distilledIds: string[] = [];
	let omittedDecisionCount = 0;

	// A contradictory verdict collapses to keep before anything is committed.
	for (const id of conflictedIds) {
		accumulated.set(id, {
			id,
			outcome: "keep",
			rationale: "conflicting decisions returned for this observation; kept by default",
		});
	}

	for (const candidate of candidates) {
		const explicit = accumulated.get(candidate.id);
		if (!explicit) omittedDecisionCount++;
		// Fail closed: silence means keep, never drop.
		const decision: AdjudicationDecision = explicit ?? {
			id: candidate.id,
			outcome: "keep",
			rationale: "no decision returned; kept by default",
		};
		decisions.push(decision);
		switch (decision.outcome) {
			case "keep":
				keptIds.push(candidate.id);
				break;
			case "retire":
				retiredIds.push(candidate.id);
				break;
			case "replace":
				replacedIds.push(candidate.id);
				break;
			case "distill":
				distilledIds.push(candidate.id);
				break;
		}
	}

	debugLog("adjudicator.result", {
		reason: toolCallCount === 0 ? "no_tool_call" : keptIds.length === candidates.length ? "all_kept" : "decided",
		candidateCount: candidates.length,
		toolCallCount,
		rawDecisionCount,
		unknownCandidateIdCount,
		duplicateDecisionCount,
		conflictingDecisionCount,
		rejectedDecisionCount,
		replaceWithUnknownReflectionCount,
		retireWithUnknownSupersessionCount,
		distillAlreadyReflectedCount,
		distillMergedIntoExistingCount,
		omittedDecisionCount,
		...buildAdjudicationMetrics({
			candidates,
			coverageById,
			decisions,
			reflections,
			distilledReflections: Array.from(distilledById.values()),
			anchorByOutcome,
			anchorMissingSample,
			durationMs: Date.now() - startedAt,
		}),
		keptCount: keptIds.length,
		retiredCount: retiredIds.length,
		replacedCount: replacedIds.length,
		distilledCount: distilledIds.length,
		distilledReflectionCount: distilledById.size,
	});

	return {
		decisions,
		distilled: Array.from(distilledById.values()),
		keptIds,
		retiredIds,
		replacedIds,
		distilledIds,
	};
}