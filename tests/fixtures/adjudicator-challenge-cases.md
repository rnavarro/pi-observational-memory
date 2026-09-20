# Adjudicator challenge cases

These cases exist because the unit tests drive a **fake** agent loop
(`tests/eviction-adjudicator.test.ts` stubs `context.tools[0].execute`), so they
exercise the accumulator, not the model's judgment. Nothing in the test suite
can show that the adjudicator *chooses* well. These cases are the judgment
checks, and they require a real model.

Status: **not automated.** Each case is written so it can be pasted as a
candidate into a live adjudicator run and its verdict inspected. Do not treat a
green suite as evidence for any of them.

| Case | Source observation | Expected | Why |
| --- | --- | --- | --- |
| Dropped negation | "`reflectionsForDropper` is not yet exported from the ledger index" | keep, or distill preserving "not yet" | The anchor `reflectionsForDropper` survives a lossy rewrite, so anchor survival cannot see this. |
| Dropped pending approval | "User approved option A; do A" vs "User approved option A" | distill must carry the approval, never retire | An approval is a completed decision; losing it re-asks a settled question. |
| Dropped "pending" qualifier | "Migration is designed but not yet applied" | keep or distill with the qualifier | Same anchor set, opposite operational meaning. |
| Near-duplicate reflection missing one qualifier | Observation carries two facts; the cited reflection carries only one | keep or distill, never replace | Replace is only for equivalent fidelity; a subset is not equivalent. |
| Historical evidence labelled superseded | A record whose successor records a *contradiction* | retire **with** `supersededById` | Supersession is evidence the record is obsolete, not a claim the successor preserves it. |
| Transient progress note | "Tests pass, typecheck clean" with no identifiers | retire | The intended disposable class; the rare case where loss is correct. |

## What a real-model check should assert

1. For every candidate the model retires, the stated rationale is checkable
   against a named record (the constructor enforces resolvability; it cannot
   judge truth).
2. No candidate in the preserved classes above is retired.
3. A distillation of a case with a negation or a qualifier keeps that negation or
   qualifier in `distilledContent`.
4. The rendered post-fold context still lets an executor recover the pending
   approval and distinguish completed from proposed work.

## Why there is no anchor gate

The anchor diagnostic (`src/agents/adjudicator/anchors.ts`) is log-only because a
measured 4-of-5 sub-60% anchor cases were formatting artifacts rather than lost
facts, and because anchors are blind to exactly the cases in the table above.
`tests/eviction-anchors.test.ts` pins that blind spot deliberately.