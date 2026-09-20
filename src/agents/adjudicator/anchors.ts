/**
 * Structural-anchor survival check for distillation and replacement.
 *
 * This is a DIAGNOSTIC, deliberately non-blocking. Mechanical extraction cannot
 * establish semantic fidelity: an anchor that survives can still sit in a
 * sentence whose negation, scope, or obligation was dropped, and an anchor that
 * goes missing is often only a formatting change (a UUID re-hyphenated, a path
 * split across two words). It also says nothing at all about the sources that
 * carry no anchors. What it can do is make the omission rate observable, so that
 * a real loss rate can be measured before anyone considers enforcing a gate.
 *
 * Anchors are the concrete identifiers whose loss is most visible downstream:
 * paths, commit-ish hashes, versions, camelCase symbols, and SCREAMING_CASE
 * constants. A hex run must contain a digit, so ordinary words spelled from
 * a-f are not mistaken for hashes.
 */
const ANCHOR_PATTERNS: readonly RegExp[] = [
	// path-like, any number of segments: src/a/b.go, ./rel/path.ts
	/(?:\b[\w.-]+\/)+[\w.-]+\.[A-Za-z]\w{0,6}\b/g,
	// commit-ish hex or hyphenated UUID, requiring at least one digit so ordinary
	// words spelled from a-f are not mistaken for hashes
	/\b(?=[0-9a-f-]*\d)[0-9a-f][0-9a-f-]{6,39}\b/g,
	// semantic version
	/\b\d+\.\d+\.\d+\b/g,
	// camelCase / PascalCase symbol, including short ones such as hashId
	/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]+\b/g,
	// SCREAMING_CASE constant
	/\b[A-Z][A-Z0-9]{2,}_[A-Z0-9_]{2,}\b/g,
];

/** Distinct structural anchors in `content`, in first-seen order. */
export function extractAnchors(content: string): string[] {
	const found = new Set<string>();
	for (const pattern of ANCHOR_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of content.matchAll(pattern)) found.add(match[0]);
	}
	return Array.from(found);
}

/**
 * Anchors present in `sourceContent` that do not appear verbatim in
 * `survivingContent`. Empty means every extracted anchor carried over.
 *
 * Callers bound their own log volume by sampling candidates, not by trimming an
 * individual result: a sampled case is only useful if it shows every anchor that
 * went missing.
 */
export function missingAnchors(sourceContent: string, survivingContent: string): string[] {
	return extractAnchors(sourceContent).filter((anchor) => !survivingContent.includes(anchor));
}