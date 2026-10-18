import type { SpecModel } from "../../spec/graph/types.ts"
import type { QueryCatalog } from "./catalog.ts"
import type { DoctorFacts } from "./doctor-facts.ts"
import { block } from "./doctor-text.ts"
import { TAG_REMEDY } from "./tags.ts"

/** Gaps listed per tag before the rest are counted. */
const GAPS_SHOWN = 4

/** The declared limits of a catalog row, as `key=value` pairs. */
function catalogExtras(row: QueryCatalog): string[] {
	const pairs: Array<[string, unknown]> = [
		["identityFilter", row.identityFilter],
		["emptyIn", row.emptyIn],
		["maxInValues", row.maxInValues],
		["maxFilterConditions", row.maxFilterConditions],
		["searchEmpty", row.searchEmpty],
		["searchModes", row.searchModes?.join(",")],
		["sort.nulls", row.sort?.nulls?.join(",")],
		["sort.maxKeys", row.sort?.maxKeys],
		["defaultOrder", row.sort?.defaultOrder],
		["stableTiebreak", row.sort?.stableTiebreak],
		["select.unknown", row.select?.unknown],
		["select.nested", row.select?.nested],
	]
	return pairs.filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${String(value)}`)
}

function catalogRowLines(row: QueryCatalog): string[] {
	const ops = row.operators === undefined ? "implicit eq/neq/gt/gte/lt/lte/like" : row.operators.join(",")
	const extras = catalogExtras(row)
	return [
		`    ${row.entity}  source=${row.source}${row.hook ? " +hook" : ""}${row.harvest.length > 0 ? ` harvest=${row.harvest.join(",")}` : ""}`,
		...(row.grammar === undefined ? [] : [`      grammar     ${row.grammar}`]),
		...(row.sortGrammar === undefined ? [] : [`      sort        ${row.sortGrammar}`]),
		`      filterable  ${row.filterable.map((field) => field.field).join(", ") || "—"}  ops ${ops}`,
		`      sortable    ${row.sortable.map((field) => field.field).join(", ") || "—"}`,
		`      searchable  ${row.searchable.join(", ") || "—"}`,
		`      selectable  ${row.selectable.join(", ") || "—"}`,
		...(extras.length === 0 ? [] : [`      ${extras.join("  ")}`]),
		row.checks.length > 0
			? `      will apply  ${row.checks.join(", ")}`
			: "      will apply  (none of the declared-or-skip catalog checks)",
	]
}

/** Per listable entity, what its list can be queried by and which query checks that lets run. */
export function catalogLines(facts: DoctorFacts): string[] {
	return block(
		"  query catalog (declared or skip — missing capability does not apply)",
		facts.catalogs.flatMap(catalogRowLines),
	)
}

/** Where each operation's answer keeps its record and the id of what it made, as declared. */
export function envelopeLines(model: SpecModel): string[] {
	const located = model.operations
		.filter((op) => op.recordPath !== null || op.createdIdFrom !== null)
		.sort((a, b) => a.operationId.localeCompare(b.operationId))
	return block(
		"  record envelopes (x-entity.recordPath / createdIdFrom)",
		located.map((op) => {
			const parts = [
				op.recordPath === null ? null : `record ${op.recordPath}`,
				op.createdIdFrom === null ? null : `created id ${op.createdIdFrom}`,
			].filter((part) => part !== null)
			return `    ${op.operationId.padEnd(28)} ${parts.join("  ")}`
		}),
	)
}

/** A document that secures its operations but offers no way to obtain a credential. */
export function authLines(model: SpecModel): string[] {
	if (model.hasAuthOperations || model.securitySchemes.length === 0) return []
	return [
		"  auth",
		`    document declares ${model.securitySchemes.map((s) => `"${s}"`).join(", ")} but contains no`,
		"    operation for obtaining a credential. No generic client can bootstrap from",
		"    this spec. Add the auth operations, or declare x-auth-flows at document root.",
		"",
	]
}

export function externalRefLines(externalRefs: string[]): string[] {
	return block(
		"  unresolved external $refs (not fetched — a test tool should not follow arbitrary URLs)",
		externalRefs.map((ref) => `    ${ref}`),
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
