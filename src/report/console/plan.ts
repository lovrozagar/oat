import { estimateRequests } from "../../runtime/check-costs.ts"
import { describeRequested } from "../../runtime/scope/plan.ts"
import { type ScopePlan } from "../../runtime/scope/types.ts"
import { formatUniqueSets } from "../../spec/extensions/unique.ts"
import type { EntityModel, SpecModel } from "../../spec/graph/types.ts"
import {
	type DeclaredGrammar,
	declaredGrammars,
	hasInvite,
	inviteAcceptMode,
	lifecycleGlyphs,
	sortedEntities,
} from "./describe.ts"

function planJson(model: SpecModel, grammars: DeclaredGrammar[], scope?: ScopePlan): string {
	return `${JSON.stringify(
		{
			entities: [...model.entities.values()].map((entity) => ({
				...entity,
				estimatedRequests: estimateRequests(entity, model),
			})),
			...(grammars.length === 0 ? {} : { grammars }),
			operations: model.operations,
			roots: model.roots,
			...(scope === undefined ? {} : { scope }),
			unique: [...model.entities.values()]
				.filter((entity) => entity.unique !== null)
				.map((entity) => ({ entity: entity.name, unique: entity.unique })),
		},
		null,
		2,
	)}\n`
}

/** One row per entity: its lifecycle, identity, cost, and the routes that read it. */
function entityTable(model: SpecModel, entities: EntityModel[]): string[] {
	const lines = [
		"",
		`  ${model.operations.length} operations · ${entities.length} entities`,
		"",
		"  entity              CLRUD  ident        ~req  read surface",
		"  ─────────────────────────────────────────────────────────────────────",
	]
	for (const entity of entities) {
		const surface =
			entity.readSurface.length === 0
				? "— none"
				: `${entity.readSurface.length} route(s)${entity.declaredSurface.length > 0 ? " (declared)" : " (inferred)"}`
		lines.push(
			`  ${entity.name.padEnd(18)}  ${lifecycleGlyphs(entity)}  ${(entity.identity ?? "—").padEnd(9)}  ` +
				`${String(estimateRequests(entity, model)).padStart(5)}  ${surface}`,
		)
		for (const route of entity.readSurface) lines.push(`  ${"".padEnd(45)}${route}`)
	}
	const total = entities.reduce((sum, entity) => sum + estimateRequests(entity, model), 0)
	lines.push("")
	lines.push(`  ~${total} requests estimated for a full run, from typical per-check costs`)
	return lines
}

/** A titled block of indented rows, or nothing when there are no rows. */
function block(title: string, rows: string[]): string[] {
	return rows.length === 0 ? [] : ["", title, ...rows.map((row) => `    ${row}`)]
}

/** What a run needs supplied, and what the document declares about gates, uniqueness, invites and grammars. */
function declarations(model: SpecModel, entities: EntityModel[], grammars: DeclaredGrammar[]): string[] {
	const gated = model.operations.filter((op) => op.featureGate !== null)
	const uniqued = entities.filter((entity) => entity.unique !== null)
	const invited = entities.filter(hasInvite)
	return [
		...block("  roots — no create operation, must be supplied before a run:", model.roots),
		...block(
			"  feature gates — a matching 403 is coverage, not a defect:",
			gated.map((op) => `${op.operationId.padEnd(28)} x-feature-gate: ${op.featureGate}`),
		),
		...block(
			"  unique constraints — a 409 on a duplicate of these columns is a pass:",
			uniqued.map((entity) => `${entity.name.padEnd(28)} x-unique: ${formatUniqueSets(entity.unique)}`),
		),
		...block(
			"  invite — accept mode:",
			invited.map((entity) => `${entity.name.padEnd(28)} ${inviteAcceptMode(entity.invite)}`),
		),
		...block(
			"  declared grammars — how oat writes this entity's filter and sort terms:",
			grammars.flatMap((row) => [
				...(row.filter === undefined ? [] : [`${row.entity.padEnd(28)} filter  ${row.filter}`]),
				...(row.sort === undefined ? [] : [`${row.entity.padEnd(28)} sort    ${row.sort}`]),
			]),
		),
	]
}

/** What a targeted run would grade, queue and call — the dry run behind `oat plan --ops`. */
function planScopeText(scope: ScopePlan): string {
	const lines: string[] = ["", `  scope: targeted (${describeRequested(scope.requested)})`, ""]
	const width = Math.max(12, ...[...scope.targets, ...scope.untestable].map((t) => t.operationId.length)) + 2
	lines.push("  targets")
	if (scope.targets.length === 0) lines.push("    — none gradable")
	for (const target of scope.targets) {
		lines.push(
			`    ${target.operationId.padEnd(width)}entity ${(target.entity ?? "—").padEnd(14)}${target.checks.length} check(s)`,
		)
	}
	if (scope.untestable.length > 0) {
		lines.push("  untestable — a run reports these untested and exits 1")
		for (const item of scope.untestable) lines.push(`    ${item.operationId.padEnd(width)}${item.reason}`)
	}
	if (scope.excluded.length > 0) {
		lines.push("  excluded by the profile")
		for (const item of scope.excluded) lines.push(`    ${item.operationId.padEnd(width)}${item.reason}`)
	}
	for (const [origin, ops] of Object.entries(scope.origins)) {
		lines.push(`  origin ${origin}: ${ops.join(", ")}`)
	}
	lines.push(`  entities queued: ${scope.entities.length === 0 ? "none" : scope.entities.join(", ")}`)
	lines.push(`  support (called, never graded): ${scope.support.length === 0 ? "none" : scope.support.join(", ")}`)
	lines.push("")
	return lines.join("\n")
}

/** `oat plan`: the test model derived from the document, as text or JSON; the targeted scope when there is one. */
export function plan(model: SpecModel, asJson: boolean, scope?: ScopePlan): string {
	const grammars = declaredGrammars(model)
	if (asJson) return planJson(model, grammars, scope)
	if (scope !== undefined) return planScopeText(scope)
	const entities = sortedEntities(model)
	return [...entityTable(model, entities), ...declarations(model, entities, grammars), ""].join("\n")
}
