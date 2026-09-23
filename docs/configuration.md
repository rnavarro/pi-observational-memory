# Configuration

This page documents the current V3 configuration for `pi-observational-memory`.

V3 keeps the existing `observational-memory` settings namespace, but the setting names changed. Old V2 keys are not aliases; they are ignored. If you are upgrading, read [Migrating from V2](#migrating-from-v2).

## Where settings live

Pi reads settings from:

1. Global settings: `~/.pi/agent/settings.json`
2. Project settings: `<project>/.pi/settings.json`
3. Environment override: `PI_OBSERVATIONAL_MEMORY_PASSIVE`

Project settings override global settings. `PI_OBSERVATIONAL_MEMORY_PASSIVE` overrides only `passive` when set to a recognized value.

All extension-owned settings live under:

```json
{
  "observational-memory": {}
}
```

The extension loads config once for its runtime. After changing settings, restart Pi or reload the extension so the new values are picked up.

## Full V3 example

```json
{
  "observational-memory": {
    "observeAfterTokens": 10000,
    "reflectAfterTokens": 20000,
    "observerChunkMaxTokens": 60000,
    "compactAfterTokens": 81000,
    "observationsPoolMaxTokens": 20000,
    "observationsPoolTargetTokens": 10000,
    "observationsPoolCeilingTokens": 30000,
    "observationsPoolCeilingRatio": 0.25,
    "reflectionsBudgetTokens": 20000,
    "reflectionsBudgetRatio": 0.1,
    "reflectionsIndexTokens": 5000,
    "agentMaxTurns": 16,
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    },
    "showWorkerNotifications": true,
    "passive": false,
    "debugLog": false
  }
}
```

You can omit everything. Defaults work for ordinary sessions, and if `model` is unset the memory workers use the current session model.

## Settings reference

| Setting | Type | Default | What it controls |
| --- | ---: | ---: | --- |
| `observeAfterTokens` | positive integer | `10000` | Raw/source token threshold for observer runs. |
| `reflectAfterTokens` | positive integer | `20000` | Raw/source token threshold for reflector runs; successful reflection creates dropper maintenance opportunities. |
| `observerChunkMaxTokens` | positive integer | derived; minimum `256` | Maximum estimated tokens sent to one observer run. Unset: 20% of the resolved memory model's context window, or `60000` when unknown. |
| `compactAfterTokens` | positive integer | `81000` | Estimated source-entry threshold for proactive auto-compaction, counted after the latest compaction boundary. |
| `observationsPoolMaxTokens` | positive integer | `20000` | Normal compaction-projection observation-token pressure that makes compaction do a full fold. |
| `observationsPoolTargetTokens` | positive integer below max | half of `observationsPoolMaxTokens` | Folded active observation target used by post-reflection dropper maintenance. |
| `observationsPoolCeilingTokens` | positive integer above target | `30000` | Operational hard limit on the active observation pool. Above it, a deterministic enforcement stage evicts observations the dropper never proposed so the pool cannot grow without bound, and pool pressure alone can launch a pass. |
| `observationsPoolCeilingRatio` | number in `(0, 1)` | `0.25` | Upper cap on the ceiling as a fraction of the session model's context window, so a small window is never asked to hold a pool that would not fit. |
| `reflectionsBudgetTokens` | positive integer | `20000` | Token budget for reflections rendered in full in a fold summary. Reflections past it render as an id plus preview, and past `reflectionsIndexTokens` are counted but not listed. Bounds rendering only; the ledger keeps everything and recall still reads it. |
| `reflectionsBudgetRatio` | number in `(0, 1)` | `0.1` | Upper cap on the reflection budget as a fraction of the session model's context window. |
| `reflectionsIndexTokens` | positive integer | `5000` | Budget for the index tier that renders ids plus a short preview for reflections that did not fit the full-text budget. |
| `agentMaxTurns` | positive integer | `16` | Shared nested-agent turn cap for observer, reflector, dropper, and eviction adjudicator. |
| `agentMaxTokens` | positive integer | `32000` | Maximum output tokens requested for memory-agent loops. Clamped to the model's own `maxTokens` when available. Lower it for local servers with a modest context window. |
| `model` | object | unset | Optional model override for observer, reflector, and dropper. |
| `model.provider` | string | unset | Provider name in Pi's model registry. Required when `model` is set. |
| `model.id` | string | unset | Model id in Pi's model registry. Required when `model` is set. |
| `model.thinking` | enum | unset; workers fall back to `low` | Optional reasoning/thinking level for memory workers. |
| `showWorkerNotifications` | boolean | `true` | Shows routine observer, reflector, and dropper progress notifications. |
| `passive` | boolean | `false` | Disables proactive background memory and auto-compaction triggers. |
| `debugLog` | boolean | `false` | Writes best-effort per-session extension debug events to Pi's agent directory. |

Valid `model.thinking` values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Invalid values are ignored. Positive-integer settings must be finite integers greater than zero. `observationsPoolTargetTokens` must also be below `observationsPoolMaxTokens`; if omitted or invalid, it is derived as `Math.floor(observationsPoolMaxTokens / 2)`.

## `observeAfterTokens`

Default: `10000`.

The observer runs from Pi's `turn_end` hook. It counts raw/source tokens after the latest `om.observations.recorded.data.coversUpToId` marker. When the count reaches `observeAfterTokens`, the observer receives source entries after that marker and may append a non-empty `om.observations.recorded` ledger entry.

Lower values create smaller chunks and more frequent model calls. Higher values reduce model-call frequency but let unobserved raw conversation accumulate longer. If the observer deliberately emits no observations, no ledger entry is written; the same range remains uncovered, and the observer retries after another `observeAfterTokens` of source tokens accumulate.

## `observerChunkMaxTokens`

Default: derived as 20% of the resolved memory model's context window, or `60000` when that window is unavailable.

This caps the source-addressed text sent to one observer run. Complete source entries are added oldest-first while they fit; remaining entries stay eligible for later runs. If the oldest entry alone exceeds the budget, the observer receives a clearly marked head/tail excerpt instead of an over-context request. The original session entry is not modified, and observations still cite its original source id so the source remains traceable in the session ledger.

Set an explicit value when a provider exposes a context window that differs from Pi's model metadata. Values below `256` are clamped to `256` so a chunk can always carry a complete source label, omission marker, and useful context. Keep room for the observer system prompt, prior observations/reflections, tool schemas, and output; setting this equal to the full model window will usually fail.

## `reflectAfterTokens`

Default: `20000`.

The reflector uses this raw/source-token threshold. Reflector progress is counted after the latest `om.reflections.recorded.data.coversUpToId` marker.

The dropper no longer uses `reflectAfterTokens` as its own launch threshold. Dropper work is gated by successful reflection: after the reflector records non-empty reflections in a consolidation pass, the dropper may run if the folded active observation ledger is over `observationsPoolTargetTokens`. It can see same-turn new reflections before deciding what to prune.

Lower values distill reflections more often and therefore create more opportunities for post-reflection dropper maintenance. Higher values reduce reflector model calls but leave more observations between reflection and dropper opportunities.

## `compactAfterTokens`

Default: `81000`.

The auto-compaction trigger runs from Pi's `agent_settled` hook, after retries, automatic compaction, and queued continuation finish. It counts estimated source-entry tokens after the latest compaction boundary. The count starts at `firstKeptEntryId` when Pi provides that boundary, so retained source entries remain part of the metric. Memory ledger entries and compaction metadata contribute zero. If the count reaches `compactAfterTokens`, the extension defers with `setTimeout(0)`, checks that Pi is idle, re-checks the same metric, and calls `ctx.compact()`. Pi's provider context usage is not used for this threshold.

This trigger does not wait for observer, reflector, or dropper work. Actual compaction summary creation happens later in `session_before_compact`. A non-empty V3 projection is rendered deterministically and model-free; an empty projection delegates to Pi's native summarizer so prior context is not replaced by an empty summary.

Pi's own window-pressure compaction and manual compaction can still happen independently of this proactive trigger.

## `observationsPoolMaxTokens`

Default: `20000`.

This controls V3's full-fold pressure. During compaction, the extension builds the normal compaction projection: observations whose `coversUpToId` reaches the compaction boundary, with reflection/drop effects held stable from the latest full fold. If there is no previous full fold, normal compaction includes observations only. If that projection's active observation tokens are at or above `observationsPoolMaxTokens`, compaction performs a full fold through the compaction boundary and applies observations, reflections, and drops by coverage marker. Otherwise, it keeps reflection/drop effects stable from the latest full fold and projects only observations through the new boundary.

This is not the active observation dropper target and not a scheduling threshold for the reflector. Use `observationsPoolTargetTokens` for dropper active observation maintenance and `reflectAfterTokens` for reflector cadence.

## `observationsPoolTargetTokens`

Default: half of `observationsPoolMaxTokens`.

This controls the folded active observation target used by the dropper. If folded active observation tokens are at or below this target, the dropper has no maintenance work. If they are over target, the dropper can run only after the reflector records non-empty reflections in the same consolidation pass.

With the defaults, `observationsPoolMaxTokens` is `20000` and `observationsPoolTargetTokens` is `10000`. If the active observation pool reaches about `20000` tokens, the dropper computes a maximum count intended to move it back toward about `10000` tokens, but the model may drop fewer or none.

When the dropper runs, it computes how many tokens are over target, converts that token excess to an approximate observation-count maximum using average active observation size, and passes that maximum to the model as a hard upper bound. The model may drop fewer or none, and code still rejects invalid or duplicate candidates.

Dropper input includes deterministic reflection coverage evidence for every active observation: `none` means no current reflection supports the observation id, `partial` means one reflection supports it, and `strong` means two or more reflections support it. Coverage is evidence for the model, not an automatic drop rule. Relevance is importance/resistance rather than an absolute lock: `critical` observations require the strongest evidence, but older covered/superseded critical observations may leave active memory when semantic safety is clear. Dropping does not delete ledger history; known ids remain recallable.

This target does not affect compaction full-fold pressure. Visible compaction pressure remains based on `observationsPoolMaxTokens`.

## `observationsPoolCeilingTokens`

Default: `30000`.

This is the operational hard limit on the active **observation** pool. It is deliberately separate from `observationsPoolMaxTokens`: that setting decides when compaction rebuilds its prefix, which is a prompt-cache question, while the ceiling decides when the extension stops honouring eviction vetoes over observations. It bounds observations only; the reflection half of the rendered memory is bounded separately by `reflectionsBudgetTokens`. See "Reflection budget" in `how-it-works.md`.

While the pool is at or below the ceiling, the eviction adjudicator's `keep` verdicts are honoured. Above it, a deterministic enforcement stage evicts observations the dropper never proposed: lowest relevance first, then oldest, taking only as many records as needed to return to the ceiling. Each eviction is recorded as a `retire` decision carrying a fixed ceiling rationale, logged as `dropper.ceiling_enforced`, and surfaced as a user-visible warning, so policy-authorised loss is attributable rather than silent.

**This is an availability-first policy, stated rather than implied.** Above the ceiling the adjudicator's preservation floor is capacity-conditional, not absolute. The alternative policy is preserve-first: stop admitting work and block model execution until memory is resolved. That was rejected deliberately — wedging the assistant is a worse default here than bounded, attributed, visible loss. If you would rather not lose records you asked to keep, set the ceiling so it is not reached, and treat the warning as a configuration signal.

Enforcement is a stage of its own that runs after every model stage and independently of them, and pool pressure is by itself enough to launch a consolidation pass. That matters because the dropper waits for a fresh reflection batch and the batch planner can only commit what the dropper proposed — so an aborted stage, a worker error, or an empty proposal would all otherwise leave the pool above its ceiling. The enforcement stage needs no model, so a pass launched only for pool pressure makes no model calls.

The effective ceiling is `min(observationsPoolCeilingTokens, observationsPoolCeilingRatio x contextWindow)` and is never below `observationsPoolTargetTokens`. The ratio keeps a small context window from being asked to hold a pool that would not fit in it; the absolute value stops a very large advertised window from producing an unbounded pool. If the two settings produce a ceiling equal to the target, the ceiling has no headroom and enforcement evicts under any target pressure.

## `observationsPoolCeilingRatio`

Default: `0.25`.

Ceiling as a fraction of the active session model's context window, applied as an upper cap on `observationsPoolCeilingTokens`. The folded pool is rendered into the compaction summary that the session model reads, so the session model's window is the binding constraint, not the memory worker's.

## `reflectionsBudgetTokens`

Default: `20000`.

The observation pool has a ceiling; reflections had no bound at all. Measured across 1846 real folds, the rendered reflection list reached 156,663 tokens (984 reflections) and formed 61% of the rendered memory payload at median, 94% at worst. Since that payload replaces the model's context after compaction, it is a direct claim on the context window, and in the worst measured case the whole summary occupied 51% of a 272K-token window while the capped observation pool stayed inside its budget.

This bounds **rendering only**. Every reflection stays in the ledger, `/om:view recorded` still lists them all, and the recall tool reads any of them by id. Reflections that do not fit the full-text budget are rendered as an index line carrying the id and a short preview, so the model can see that the record exists and ask for it. Only after `reflectionsIndexTokens` is exhausted are the remaining records counted in a line rather than listed. Those records are found again with `search_memory`; see "Discovery" in `how-it-works.md`.

The effective budget is `min(reflectionsBudgetTokens, reflectionsBudgetRatio x contextWindow)`, so a small window is not asked to hold a fixed budget that would not fit, while a very large advertised window does not produce an unbounded one. The same ratio caps `reflectionsIndexTokens`, so a small window shrinks the whole reflected payload rather than only its full-text half. Within the budget, reflections are rendered newest-first in ledger order: the current state of a session is carried by its later reflections, and the observation pool is already recency-bounded by the fold boundary. Reflections named as a drop witness are pinned into the full-text tier regardless of recency, since a dropped observation's only remaining trace in context is the reflection its decision named.

Set it generously to render more of the reflection history inline and rely on recall less. Set it low, or lower `reflectionsIndexTokens`, when a fold summary must leave more of the window to the conversation. Setting `reflectionsIndexTokens` to a small value increases the number of records that are counted but not listed, which means the model cannot see them inline and must search for them (`search_memory`) rather than read an id off the summary.

## `reflectionsBudgetRatio`

Default: `0.1`.

Reflection budget as a fraction of the active session model's context window, applied as an upper cap on `reflectionsBudgetTokens`. Like the observation ceiling, the binding window is the session model's, because the session model is what reads the fold summary.

## `reflectionsIndexTokens`

Default: `5000`.

Budget for the index tier: reflections that did not fit `reflectionsBudgetTokens` are rendered as `[id] <preview>` lines within this budget, newest-first. At the default preview length one index line is roughly 25 tokens, so the default holds a few hundred records.

The index is what keeps a bounded summary honest. Without it, a reflection that fell outside the budget would be unreachable in practice, because the model would never learn its id to pass to recall. Records past the index budget are still in the ledger, and a summary line states how many there are, naming `search_memory` so they can be found by content rather than by an id the model never saw.

Be aware of what the index is not. It is an addressability floor, not search: the model can only retrieve a record whose id it has seen, and it can only see ids that were rendered or indexed. See "What this does not provide" in `how-it-works.md` before treating the bounded summary as equivalent to the unbounded one.

## `agentMaxTurns`

Default: `16`.

This is the shared nested-agent turn cap for the observer, reflector, dropper, and eviction adjudicator. A turn is one assistant/model response cycle inside Pi's agent loop. The cap is not a token budget and not a literal tool-call counter.

Use lower values to bound background memory-worker cost. Too low can reduce observation coverage or reflection/drop quality.

## `agentMaxTokens`

Default: `32000`.

This is the maximum number of output tokens the extension requests for each memory-agent loop (observer, reflector, dropper). It is always clamped to the model's own `maxTokens` when the model advertises one.

Lower it when the memory model is a local server with a modest context window (for example, a llama.cpp server with a 64K slot). Slot KV is shared between the main session's retained cache and concurrent sub-agent requests, so a request whose combined input and response budget exceeds the window fails with `500 "Context size has been exceeded."` and the affected memory run aborts. Pairing a smaller `agentMaxTokens` (e.g. `8192`) with a low `observerChunkMaxTokens` keeps sub-agent requests inside the window.

## `model`

Default: unset, meaning memory workers use the session model.

Set `model` when you want the observer, reflector, dropper, and eviction adjudicator to use a cheaper or faster model than the main coding agent:

```json
{
  "observational-memory": {
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    }
  }
}
```

`provider` and `id` must both be non-empty strings. `thinking` is optional. If the configured model cannot be resolved, the runtime attempts to fall back to the current session model and notifies once. Memory workers accept either an API key or OAuth-style auth headers (e.g. `Authorization: Bearer …`), so OAuth-authenticated providers work without an API key. If no usable model or credentials are available, the relevant background worker skips/fails safely rather than inventing memory.

Workers stream through Pi's composed provider runtime, not `@earendil-works/pi-ai/compat` alone. Session models whose `api` id comes from `pi.registerProvider` (`cursor-sdk`, CLIProxyAPI, commandcode, and other custom APIs) work without a second built-in provider. `model` remains optional: set it only when you want cheaper/faster workers than the coding agent. Leaving it unset is the Cursor-only setup.

## `showWorkerNotifications`

Default: `true`.

When `false`, the extension hides routine observer, reflector, and dropper progress notifications (including deliberate-empty observer info messages). Model fallback/unavailability, worker failures (including observer stream errors), compaction notifications, and explicit `/om:*` command output remain visible.

## `passive`

Default: `false`.

When `true`, the extension does not proactively run the observer, reflector/dropper lane, or auto-compaction trigger. Manual/Pi compaction hooks, `/om:status`, `/om:view`, `recall`, and `search_memory` remain available.

Environment override:

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=true pi
```

Truthy values: `1`, `true`, `yes`, `on`.

Falsy values: `0`, `false`, `no`, `off`.

Unrecognized values are ignored.

## `debugLog`

Default: `false`.

When enabled, the extension writes best-effort NDJSON debug events under Pi's agent directory. Normal Pi sessions write to a per-session file:

```txt
observational-memory/debug/<session-id>.ndjson
```

Contexts without a usable session id fall back to the legacy global file:

```txt
observational-memory/debug.ndjson
```

Each row includes event metadata such as `sessionId`, `sessionFile`, `runId`, `cwd`, and event-specific `data`. `runId` identifies one consolidation pipeline inside a session file, so you can filter a session log to a single observer/reflector/dropper/adjudicator pass.

Dropper diagnostics are especially useful when the active observation pool is over target but no drops are appended. For example:

```bash
grep '"event":"dropper' ~/.pi/agent/observational-memory/debug/<session-id>.ndjson | tail -n 50
```

Look for `dropper.result`: `no_tool_call` means the model chose not to drop anything, `all_filtered` means proposed ids were unusable, and `selected_nonempty` means usable drops were selected before append handling.

For the questions that decide whether eviction is safe — which tier was dropped, which outcome lost an anchor, whether the pool is actually shrinking, how close it came to the ceiling — see "Eviction observability" in `how-it-works.md`, which lists every field and the decision it supports.

Debug logs are opt-in local debugging artifacts. By default, diagnostic events should record aggregate counts, token totals, ids, file paths, errors, and project details rather than observation/reflection content, prompts, model responses, or raw model-proposed drop ids. Treat debug files as sensitive local artifacts.

Debug-log write failures do not change memory behavior.

## Migrating from V2

V3 is not backwards compatible with V2 settings. Old keys are silently ignored and do not act as aliases.

| V2 setting | V3 setting | Migration note |
| --- | --- | --- |
| `observationThresholdTokens` | `observeAfterTokens` | Rename. Same rough observer-cadence role. |
| `compactionThresholdTokens` | `compactAfterTokens` | Rename. Same rough proactive-compaction role. |
| `reflectionThresholdTokens` | `reflectAfterTokens`, `observationsPoolMaxTokens`, and/or `observationsPoolTargetTokens` | Split. Use `reflectAfterTokens` for reflector cadence, `observationsPoolMaxTokens` for compaction full-fold pressure, and `observationsPoolTargetTokens` for dropper active observation maintenance. |
| `compactionModel` | `model` | Move `{ provider, id }` under `model`. |
| `thinkingLevel` | `model.thinking` | Move under `model`. |
| `observerMaxTurnsPerRun` | `agentMaxTurns` | Replace with one shared cap. |
| `reflectorMaxTurnsPerPass` | `agentMaxTurns` | Replace with one shared cap. |
| `prunerMaxTurnsPerPass` | `agentMaxTurns` | Replace with one shared cap; V3 calls the role the dropper. |
| `compactionMaxToolCalls` | none | Remove. No V3 replacement. |
| `passive` | `passive` | Keep if desired. |
| `debugLog` | `debugLog` | Keep if desired. |

Old V2 memory entries and old V2 compaction details are ignored by V3. Start a new clean Pi session after upgrading to V3 so old visible summaries and old memory formats do not confuse the transition.

## Tuning recipes

### Lower background cost

```json
{
  "observational-memory": {
    "observeAfterTokens": 20000,
    "reflectAfterTokens": 50000,
    "agentMaxTurns": 8,
    "model": { "provider": "openrouter", "id": "a-cheaper-model", "thinking": "off" }
  }
}
```

Tradeoff: fewer background model calls, but memory updates lag longer, observation chunks are larger, and reflection/drop cleanup happens less often.

### More responsive memory

```json
{
  "observational-memory": {
    "observeAfterTokens": 750,
    "reflectAfterTokens": 3000,
    "agentMaxTurns": 16,
    "model": { "provider": "openrouter", "id": "a-fast-model", "thinking": "low" }
  }
}
```

Tradeoff: more background model calls.

### Disable proactive work temporarily

```json
{
  "observational-memory": {
    "passive": true
  }
}
```

Or for one shell:

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=1 pi
```

## See also

- [concepts.md](concepts.md) — vocabulary and mental model.
- [how-it-works.md](how-it-works.md) — lifecycle and data shapes.
- [../README.md](../README.md) — quick start and V2 migration summary.
