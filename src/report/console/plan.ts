import type { Hooks } from "../../config/types/hooks.ts"
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
	modeledEntities,
	sortedEntities,
} from "./describe.ts"
import { type SecurityCredentials, type SecurityFacts, securityFacts, securityJson } from "./security.ts"
import { planSecurityLines, targetSecurity } from "./security-text.ts"
import { type Roots, rootsJson, rootsOf } from "./roots.ts"

/** What `plan` shows beside the model: the targeted scope, and the operations the config's recipes send. */
export interface PlanView {
	scope?: ScopePlan | undefined
	/** An entity the auth flow owns through one of these is left out, as a run leaves it out. */
	authCreates?: ReadonlySet<string>
	/** The config's recipes and principals: with them, each operation names the principal that sends it. */
	credentials?: SecurityCredentials | undefined
	/** Variables the config names that are not set; listed in the JSON, given only with a config. */
	unsetEnv?: string[] | undefined
	/** The config's hooks: `resolvePathValue` supplies every root. */
	hooks?: Pick<Hooks, "resolvePathValue"> | undefined
}

/* The roots split as `rootsOf` splits them, from what of the config the view carries. */
function viewRoots(model: SpecModel, view: PlanView): Roots {
	return rootsOf(model, {
		...(view.credentials === undefined ? {} : { credentials: view.credentials }),
		...(view.hooks === undefined ? {} : { hooks: view.hooks }),
	})
}

function planJson(model: SpecModel, grammars: DeclaredGrammar[], view: PlanView): string {
	const { authCreates = new Set(), scope, unsetEnv } = view
	const entities = modeledEntities(model, authCreates)
	return `${JSON.stringify(
		{
			entities: entities.map((entity) => ({
				...entity,
				estimatedRequests: estimateRequests(entity, model),
			})),
			...(grammars.length === 0 ? {} : { grammars }),
			operations: model.operations,
			...rootsJson(viewRoots(model, view)),
			...(scope === undefined ? {} : { scope }),
			security: securityJson(securityFacts(model, view.credentials)),
			unique: entities
				.filter((entity) => entity.unique !== null)
				.map((entity) => ({ entity: entity.name, unique: entity.unique })),
			...(unsetEnv === undefined ? {} : { unsetEnv }),
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
	lines.push(...stalenessLine(model, entities))
	return lines
}

/* The entities `consistency.staleness-within-bound` writes and watches: a create, an item read, and an update or a delete. */
function stalenessLine(model: SpecModel, entities: readonly EntityModel[]): string[] {
	const measured = entities.filter(
		(e) => e.create !== undefined && e.read !== undefined && (e.update ?? e.delete) !== undefined,
	)
	const bounded = measured.filter((e) => model.byOperationId.get(e.read as string)?.consistency?.stalenessMs != null)
	if (measured.length === 0) return []
	const noun = `${measured.length} entit${measured.length === 1 ? "y" : "ies"}`
	return [
		`  consistency.staleness-within-bound measures ${noun}, ${bounded.length === 0 ? "none" : bounded.length} against a declared staleness`,
	]
}

/** A titled block of indented rows, or nothing when there are no rows. */
function block(title: string, rows: string[]): string[] {
	return rows.length === 0 ? [] : ["", title, ...rows.map((row) => `    ${row}`)]
}

/** What a run needs supplied, and what the document declares about gates, uniqueness, invites and grammars. */
function declarations(
	model: SpecModel,
	entities: EntityModel[],
	view: { grammars: DeclaredGrammar[]; roots: Roots },
): string[] {
	const { grammars, roots } = view
	const gated = model.operations.filter((op) => op.featureGate !== null)
	const uniqued = entities.filter((entity) => entity.unique !== null)
	const invited = entities.filter(hasInvite)
	return [
		...block("  roots — no create operation, must be supplied before a run:", roots.required),
		...block(
			"  roots the config supplies:",
			roots.supplied.map(({ root, by }) => `${root.padEnd(20)} ${by}`),
		),
		...block(
			"  ids no operation creates — their operations run once a flow or hooks.resolvePathValue yields one:",
			roots.unmade,
		),
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
function planScopeText(scope: ScopePlan, security: SecurityFacts): string {
	const lines: string[] = ["", `  scope: targeted (${describeRequested(scope.requested)})`, ""]
	const width = Math.max(12, ...[...scope.targets, ...scope.untestable].map((t) => t.operationId.length)) + 2
	lines.push("  targets")
	if (scope.targets.length === 0) lines.push("    — none gradable")
	for (const target of scope.targets) {
		lines.push(
			`    ${target.operationId.padEnd(width)}entity ${(target.entity ?? "—").padEnd(14)}${target.checks.length} check(s)` +
				targetSecurity(security, target.operationId),
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
export function plan(model: SpecModel, asJson: boolean, view: PlanView = {}): string {
	const grammars = declaredGrammars(model)
	if (asJson) return planJson(model, grammars, view)
	const security = securityFacts(model, view.credentials)
	if (view.scope !== undefined) return planScopeText(view.scope, security)
	const entities = sortedEntities(model, view.authCreates)
	return [
		...entityTable(model, entities),
		...declarations(model, entities, { grammars, roots: viewRoots(model, view) }),
		...(model.operations.length === 0 ? [] : planSecurityLines(security)),
		"",
	].join("\n")
}
