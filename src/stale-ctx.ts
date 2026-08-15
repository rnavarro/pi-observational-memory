/**
 * Stale extension-ctx detection.
 *
 * Pi invalidates every captured extension ctx after a session replacement or
 * reload (`ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`,
 * `ctx.reload()` — including rewind tools built on them, like pi-wtf). Any
 * later use of the captured ctx throws from `ExtensionRunner.assertActive`.
 *
 * Consolidation runs can span 30+ seconds of model calls, so a user rewind
 * mid-run is routine. Staleness is a clean abort condition, not a stage
 * failure: entries produced against the replaced branch must not be appended
 * to the new session.
 */

// Loose match (not startsWith on the full sentence) so incidental rewording of
// Pi's message stays classified. If Pi ever attaches a structured code to this
// error, prefer it here and keep this test as the fallback for older hosts.
const STALE_CTX_PATTERN = /extension ctx is stale/i;

export function isStaleCtxError(error: unknown): boolean {
	if (typeof error === "string") return STALE_CTX_PATTERN.test(error);
	if (!(error instanceof Error)) return false;
	return STALE_CTX_PATTERN.test(error.message);
}

/**
 * Probe a captured ctx for staleness by touching it. Structural signal: any
 * ctx read throwing proves the ctx is unusable regardless of message wording,
 * and covers reload-with-same-session-id, which session-id comparison cannot.
 * A ctx whose sessionManager has no getBranch is reported as not stale
 * (nothing better is knowable about it).
 */
export function ctxIsStale(ctx: { sessionManager?: { getBranch?: () => unknown } }): boolean {
	try {
		ctx.sessionManager?.getBranch?.();
		return false;
	} catch {
		return true;
	}
}
