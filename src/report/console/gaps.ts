/** The `doctor` sections for what oat could not read or test: unfollowed and dangling refs, and the gaps by tag. */

import type { DoctorFacts } from "./doctor-facts.ts"
import { block } from "./doctor-text.ts"
import { TAG_REMEDY } from "./tags.ts"

/** Gaps listed per tag before the rest are counted. */
const GAPS_SHOWN = 4

/** The external refs the document named, which oat did not fetch. */
export function externalRefLines(externalRefs: string[]): string[] {
	return block(
		"  unresolved external $refs (not fetched — a test tool should not follow arbitrary URLs)",
		externalRefs.map((ref) => `    ${ref}`),
	)
}

/** The internal refs that point at nothing, each once; the `$ref` gaps say what each costs. */
export function danglingRefLines(danglingRefs: string[]): string[] {
	return block(
		"  dangling $refs (nothing in the document is at these pointers; see the $ref gaps)",
		danglingRefs.map((ref) => `    ${ref}`),
	)
}

/** The gaps, most frequent tag first, each tag with what would close it. */
export function gapLines(facts: DoctorFacts): string[] {
	const sorted = [...facts.gapsByTag.entries()].sort((a, b) => b[1].length - a[1].length)
	return block(
		"  gaps by tag",
		sorted.flatMap(([tag, gapList]) => [
			`    ${tag} (${gapList.length}) — ${TAG_REMEDY[tag] ?? "see the README"}`,
			...gapList.slice(0, GAPS_SHOWN).map((gap) => `      ${gap.operationId}: ${gap.detail}`),
			...(gapList.length > GAPS_SHOWN ? [`      … and ${gapList.length - GAPS_SHOWN} more`] : []),
		]),
	)
}
