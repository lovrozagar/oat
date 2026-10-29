import { formatUniqueSets } from "../../spec/extensions/unique.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { bypassRows } from "./bypass.ts"
import { bar, inviteAcceptMode } from "./describe.ts"
import type { DoctorConfig, DoctorFacts } from "./doctor-facts.ts"
import { declaredTags, TAG_SHARPENS, TAG_UNLOCKS } from "./tags.ts"

/** A titled block of rows, each already indented, and a blank line; nothing when there are no rows. */
export function block(title: string, rows: string[]): string[] {
	return rows.length === 0 ? [] : [title, ...rows, ""]
}

/** What `allow` removed, and how many entities a run can test and list. */
export function summaryLines(facts: DoctorFacts, config?: DoctorConfig): string[] {
	const { entities, testable, listable } = facts
	const lines = [""]
	if (config?.allowRemoved !== undefined) {
		const removed = config.allowRemoved
		lines.push(
			`  allow      ${removed.length} operation${removed.length === 1 ? "" : "s"} removed` +
				(removed.length === 0 ? "" : `: ${removed.join(", ")}`),
		)
	}
	lines.push(
		`  testable   ${bar(testable.length, entities.length)}  ${testable.length}/${entities.length} ` +
			"entities a run can seed and check",
	)
	lines.push(
		`  listable   ${bar(listable.length, entities.length)}  ${listable.length}/${entities.length} ` +
			(listable.length === 0
				? "entities have a list — query checks will not run"
				: "entities have a list, so query checks can run"),
	)
	lines.push("")
	return lines
}

/*
 * What the missing tags cost, in checks. A gap list tells an author what oat could not read;
 * this tells them what they get for fixing it, which is the only form of the message anyone
 * acts on.
 */
export function tagLines(model: SpecModel, facts: DoctorFacts): string[] {
	const declared = declaredTags(model)
	const locked = Object.entries(TAG_UNLOCKS).filter(([tag]) => !declared.has(tag))
	const lockedChecks = locked.reduce((sum, [, checks]) => sum + checks.length, 0)
	const applies: Record<keyof typeof TAG_SHARPENS, boolean> = {
		"x-query": facts.listable.length > 0,
		"x-tenant": model.operations.some((op) => op.tenantSource !== null),
	}
	const vague = (Object.entries(TAG_SHARPENS) as Array<[keyof typeof TAG_SHARPENS, string]>).filter(
		([tag]) => !declared.has(tag) && applies[tag],
	)
	return [
		...block(
			`  ${lockedChecks} check(s) cannot run against this document`,
			locked.map(([tag, checks]) => `    ${tag.padEnd(16)} would enable ${checks.join(", ")}`),
		),
		...block(
			"  running, but on inferred information",
			vague.map(([tag, effect]) => `    ${tag.padEnd(16)} ${effect}`),
		),
	]
}

/** Entities a run cannot test or list, and the roots it needs supplied. */
export function entityLines(facts: DoctorFacts): string[] {
	const itemOnly = facts.testable.filter((e) => e.list === undefined)
	return [
		...block(
			"  not testable",
			facts.untestable.map(({ entity, reason }) => `    ${entity.padEnd(20)} ${reason}`),
		),
		/* A testable entity with no list is read by its item route, its root read, or as the caller. */
		...block(
			"  no list — query, pagination and count checks will not run",
			itemOnly.map((entity) => `    ${entity.name.padEnd(20)} ${entity.read ?? (entity.readSurface[0] as string)}`),
		),
		...block(
			"  roots required in config (no create operation in this document)",
			facts.roots.required.map((root) => `    ${root}`),
		),
		...block(
			"  roots the config supplies",
			facts.roots.supplied.map(({ root, by }) => `    ${root.padEnd(20)} ${by}`),
		),
		...block(
			"  ids no operation creates — their operations run once a flow or hooks.resolvePathValue yields one",
			facts.roots.unmade.map((root) => `    ${root}`),
		),
	]
}

/** Feature gates, unique constraints, invites, and config entities the document does not have. */
export function declarationLines(facts: DoctorFacts): string[] {
	return [
		...block(
			"  feature gates — a matching 403 is a coverage gap, not a fail",
			facts.featureGates.map((gate) => `    ${gate.operationId.padEnd(28)} x-feature-gate: ${gate.featureGate}`),
		),
		...block(
			"  unique constraints — a 409 on a duplicate of these columns is a pass",
			facts.uniqueConstraints.map((row) => `    ${row.entity.padEnd(28)} x-unique: ${formatUniqueSets(row.unique)}`),
		),
		...block(
			"  invite — accept mode",
			facts.inviting.map((entity) => `    ${entity.name.padEnd(28)} ${inviteAcceptMode(entity.invite)}`),
		),
		...block("  cache bypass oat sends on reads", bypassRows(facts.bypass)),
		...block(
			"  config.entities names that do not match the document (ignored)",
			facts.unknownEntities.map((name) => `    ${name}`),
		),
	]
}
