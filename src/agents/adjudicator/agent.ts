import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool, type AgentTurnContext, type AgentTurnDecision } from "@earendil-works/pi-agent-core";
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
import type { ReplaceRelation } from "../../session-ledger/types.js";
import { coverageTierForObservation, reflectionCoverageMap, observationToDropperLine } from "../dropper/coverage.js";
import { ADJUDICATOR_SYSTEM } from "./prompts.js";
import { analyzeAnchorSurvival } from "./anchors.js";
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
	/**
	 * What the model reported the named reflection does with this record's
	 * meaning. Only `equivalent` asserts preservation; a `corrects` proposal is
	 * stored as a `retire` with supersession evidence, and `subset` is accepted
	 * but counted, so a ledger row never claims a fidelity the model did not.
	 */
	relation?: ReplaceRelation;
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
			// Optional by design. A required field the model omits would reject the
			// decision, and a rejected candidate stays in the pool under exactly the
			// ceiling pressure the refusal was meant to avoid. A missing value keeps
			// the previous behaviour and is counted instead.
			relation: Type.Optional(
				Type.Union([Type.Literal("equivalent"), Type.Literal("subset"), Type.Literal("corrects")]),
			),
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
 * The drop a proposal authorises, for duplicate comparison.
 *
 * A `replace` the model classified `corrects` is stored as a `retire` carrying
 * supersession evidence, so the two spellings of the same proposal must compare
 * equal: otherwise an identical restatement reads as a contradiction and
 * collapses the candidate to keep, which loses cleanup for no safety gain.
 */
function dropOutcomeKey(proposal: Pick<AdjudicationDecision, "outcome" | "relation">): AdjudicationOutcome {
	return proposal.relation === "corrects" ? "replace" : proposal.outcome;
}

/**
 * Rationale used when a `corrects` replace is relabelled to a `retire` and the
 * model supplied none.
 *
 * A `replace` is accepted without a rationale; a `retire` is refused without
 * one, and a refusal discards the whole entry. Passing a blank rationale through
 * the relabel would therefore let one decision refuse every other decision in
 * the batch. The fallback states only what the model's own classification
 * already asserted, and does not invent a justification for the drop.
 */
function correctionRationale(supersededById: string, rationale: string | undefined): string {
	return normalizeRationale(rationale) ?? `reflection ${supersededById} corrects or supersedes this record (relabelled from replace)`;
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

	// A reflection the model distilled earlier in this same run is not yet in
	// `existingReflectionById`, but the batch planner folds every distilled
	// reflection into `survivingReflectionIds` before the strict writer checks a
	// `replace` target or a `retire`'s evidence pointer. Validating against the
	// same set here keeps a decision the writer would have accepted, instead of
	// refusing a checkable pointer and retaining a candidate that could go.
	const reflectionContentById = (id: string): string | undefined =>
		existingReflectionById.get(id) ?? distilledById.get(id)?.content;
	const isKnownReflection = (id: string): boolean => existingReflectionById.has(id) || distilledById.has(id);

	let toolCallCount = 0;
	let rawDecisionCount = 0;
	let unknownCandidateIdCount = 0;
	let duplicateDecisionCount = 0;
	let conflictingDecisionCount = 0;
	let rejectedDecisionCount = 0;
	// Replace-classification counters. `subset` and a missing `relation` are both
	// accepted rather than refused: the purpose of this rollout is to measure how
	// often a preservation claim is not what the model actually believes, and a
	// gate on a self-reported label would only teach the model to report
	// `equivalent` instead of reporting the loss.
	let replaceSubsetCount = 0;
	let replaceCorrectsRelabelledCount = 0;
	let relationMissingCount = 0;
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
	//
	// Recorded from the FINAL decisions after the tool loop, not as each proposal
	// is accepted, so a verdict that was never committed is not credited: a
	// contradictory repeat collapses to keep, and a distillation that duplicates an
	// existing reflection commits as replace. Tallying earlier counted both under
	// the outcome the model first offered.
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
		const survival = analyzeAnchorSurvival(source.content, survivingContent);
		if (survival.extracted.length === 0) {
			tally.unanchored++;
			return;
		}
		tally.checked++;
		if (survival.missing.length === 0) {
			tally.clean++;
			return;
		}
		tally.lossy++;
		// Reformatting that carries no loss is not judged as an omission, so the
		// gap between `lossy` and `normalizedLossy` is the artifact rate. Only a
		// sample that survives normalization is worth reading, and it carries the
		// source's anchor count so a single loss is read against its denominator.
		if (survival.missingAfterNormalization.length === 0) return;
		tally.normalizedLossy++;
		if (anchorMissingSample.length < ANCHOR_SAMPLE_LIMIT) {
			anchorMissingSample.push({
				observationId,
				outcome,
				relevance: source.relevance,
				coverage: coverageForCandidate(source),
				extractedCount: survival.extracted.length,
				missing: survival.missing,
				missingAfterNormalization: survival.missingAfterNormalization,
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
					const stored = accumulated.get(proposal.id);
					if (stored && dropOutcomeKey(stored) !== dropOutcomeKey(proposal)) {
						conflictingDecisionCount++;
						conflictedIds.add(proposal.id);
					}
					continue;
				}

				if (proposal.outcome === "replace") {
					const replacementReflectionId = proposal.replacementReflectionId;
					if (!replacementReflectionId || !isKnownReflection(replacementReflectionId)) {
						replaceWithUnknownReflectionCount++;
						rejectedDecisionCount++;
						rejected++;
						continue;
					}
					if (proposal.relation === undefined) relationMissingCount++;
					else if (proposal.relation === "subset") replaceSubsetCount++;
					if (proposal.relation === "corrects") {
						// The model classified the named reflection as correcting or superseding
						// this record, so the row must not claim equivalent fidelity. Retention is
						// unchanged: the writer pins a `supersededById` exactly as it pins a
						// `replacementReflectionId`, and the projection collects both.
						replaceCorrectsRelabelledCount++;
						accumulated.set(proposal.id, {
							id: proposal.id,
							outcome: "retire",
							supersededById: replacementReflectionId,
							relation: proposal.relation,
							rationale: correctionRationale(replacementReflectionId, proposal.rationale),
						});
						counts.retire++;
						added++;
						continue;
					}
					accumulated.set(proposal.id, {
						id: proposal.id,
						outcome: "replace",
						replacementReflectionId,
						...(proposal.relation !== undefined ? { relation: proposal.relation } : {}),
						rationale: normalizeRationale(proposal.rationale),
					});
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
				if (proposal.outcome === "retire" && proposal.supersededById !== undefined && !isKnownReflection(proposal.supersededById)) {
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
	// pi 0.87 removed `AgentContext.systemPrompt`: the loop carries the base prompt
	// as the leading system message.
	const context: AgentContext = { messages: [{ role: "system", content: ADJUDICATOR_SYSTEM, timestamp: Date.now() }], tools: [decideEvictions as AgentTool<any>] };
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
		...(effectiveMaxTurns !== undefined
			? {
				// pi 0.87 replaced `shouldStopAfterTurn` with `finishTurn`, which also
				// receives error and aborted turns. Those remain hard exits, so they must
				// not consume the turn budget.
				finishTurn: (turn: AgentTurnContext): AgentTurnDecision | undefined => {
					if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return undefined;
					return ++turnCount >= effectiveMaxTurns ? { action: "end" } : undefined;
				},
			}
			: {}),
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

	// Anchor survival is read from the final decisions against the content that
	// actually authored the surviving text: the named reflection for a replace, the
	// distilled reflection for a distillation. `decisions` has already collapsed
	// contradicted ids to keep and relabelled a duplicate distillation as replace,
	// so a verdict the model later walked back is not counted for it.
	const distilledContentByObservation = new Map<string, string>();
	for (const reflection of distilledById.values()) {
		for (const observationId of reflection.supportingObservationIds) {
			distilledContentByObservation.set(observationId, reflection.content);
		}
	}
	for (const decision of decisions) {
		// A `replace` classified `corrects` is stored as a `retire`, so it is not
		// anchor-checked here: it makes no preservation claim for the named
		// reflection to satisfy.
		if (decision.outcome === "replace") {
			const target = decision.replacementReflectionId;
			recordAnchorSurvival(decision.id, "replace", target ? reflectionContentById(target) : undefined);
		} else if (decision.outcome === "distill") {
			recordAnchorSurvival(decision.id, "distill", distilledContentByObservation.get(decision.id));
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
		replaceSubsetCount,
		replaceCorrectsRelabelledCount,
		relationMissingCount,
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