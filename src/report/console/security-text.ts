import { requirementText, type SchemeCount, type SchemeFact, type SecurityFacts, satisfierText } from "./security.ts"

/* The text doctor and plan print from the security facts: aligned columns, one row per scheme, group or operation. */

const BASIC_SHOWN = "Basic base64(username:password)"
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`
const widest = (texts: readonly string[], least: number): number => Math.max(least, ...texts.map((text) => text.length))

function kindText(scheme: SchemeFact): string {
	const kind = scheme.bearerFormat === undefined ? scheme.kind : `${scheme.kind} (${scheme.bearerFormat})`
	return scheme.deprecated ? `${kind} (deprecated)` : kind
}

function placementText(scheme: SchemeFact): string {
	const placement = scheme.placement
	if (placement === null) return scheme.why as string
	const template = scheme.kind === "basic" && scheme.format === undefined ? BASIC_SHOWN : placement.template
	return `${placement.in} ${placement.name}: ${template}`
}

function recipeText(scheme: SchemeFact, configured: boolean): string {
	if (!configured) return "—"
	if (scheme.recipe === null) return "no recipe"
	const extra = scheme.extraPlacements
	return [
		scheme.recipe,
		...(scheme.format === undefined ? [] : ["format"]),
		...(extra === 0 ? [] : [`+${plural(extra, "placement")}`]),
	].join(" · ")
}

function schemeRows(facts: SecurityFacts): string[] {
	const nameWidth = widest(
		facts.schemes.map((scheme) => scheme.name),
		10,
	)
	const kindWidth = widest(facts.schemes.map(kindText), 15)
	const placed = facts.schemes.filter((scheme) => scheme.placement !== null)
	const placementWidth = widest(placed.map(placementText), 0)
	return facts.schemes.map((scheme) => {
		const head = `    ${scheme.name.padEnd(nameWidth)} ${kindText(scheme).padEnd(kindWidth)} `
		if (scheme.placement === null) return `${head}${placementText(scheme)}`
		return `${head}${placementText(scheme).padEnd(placementWidth)}   ${recipeText(scheme, facts.configured)}`
	})
}

const HINT = "    pass --config to see which principal satisfies each operation"

function groupRows(facts: SecurityFacts): string[] {
	const width = widest(
		facts.groups.map((group) => group.requirement),
		26,
	)
	return facts.groups.map((group) => {
		const row = `    ${group.requirement.padEnd(width + 2)}${String(group.operations).padStart(5)}`
		return group.satisfier === undefined ? row : `${row}   ${group.satisfier}`
	})
}

/* A titled list of schemes with what each concerns, or nothing when it is empty. */
function countBlock(title: string, rows: ReadonlyArray<SchemeCount>, tail: (row: SchemeCount) => string): string[] {
	if (rows.length === 0) return []
	const width = widest(
		rows.map((row) => row.name),
		10,
	)
	return [
		title,
		...rows.map((row) => `    ${row.name.padEnd(width)} ${plural(row.operations, "operation")}${tail(row)}`),
	]
}

/** Doctor's security block: the schemes, the requirements grouped, and what a run cannot send. */
export function securityLines(facts: SecurityFacts): string[] {
	const notes = [
		...(facts.configured
			? countBlock(
					"  no recipe — operations needing only these are untested",
					facts.noRecipe,
					(row) => `; add security.${row.name}`,
				)
			: []),
		...countBlock("  unsupported — operations needing only these are untested", facts.unsupported, () => ""),
		...countBlock(
			"  undeclared — a requirement names it, components.securitySchemes does not",
			facts.undeclared,
			() => "",
		),
	]
	return [
		`  security — ${plural(facts.schemes.length, "scheme")}`,
		...schemeRows(facts),
		"",
		...(facts.alpha === undefined ? [] : [`  writer — ${facts.alpha} (${facts.writerFrom})`, ""]),
		`  requirements — ${plural(facts.operations.length, "operation")}`,
		...groupRows(facts),
		...(facts.configured ? [] : [HINT]),
		"",
		...(notes.length === 0 ? [] : [...notes, ""]),
	]
}

/** Plan's security section: every operation, by id, with its requirement and, with a config, its principal. */
export function planSecurityLines(facts: SecurityFacts): string[] {
	const operations = facts.operations.toSorted((a, b) => a.operationId.localeCompare(b.operationId))
	const idWidth = widest(
		operations.map((op) => op.operationId),
		22,
	)
	const requirements = operations.map((op) => requirementText(op.alternatives))
	const requirementWidth = widest(requirements, 0)
	return [
		"",
		"  security — operation · requirement · principal",
		...operations.map((op, index) => {
			const row = `    ${op.operationId.padEnd(idWidth + 3)}${requirements[index] as string}`
			const satisfier = satisfierText(op, facts.alpha)
			return satisfier === undefined ? row : `${row.padEnd(4 + idWidth + 3 + requirementWidth)}   ${satisfier}`
		}),
		...(facts.configured ? [] : [HINT]),
	]
}

/** A targeted plan row's security: `  <requirement>`, with ` (<principal>)` when one is known. */
export function targetSecurity(facts: SecurityFacts, operationId: string): string {
	const op = facts.operations.find((each) => each.operationId === operationId)
	if (op === undefined) return ""
	const satisfier = satisfierText(op, facts.alpha)
	const requirement = requirementText(op.alternatives)
	return satisfier === undefined ? `  ${requirement}` : `  ${requirement} (${satisfier})`
}
