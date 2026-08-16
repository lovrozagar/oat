/**
 * Console renderers for the offline commands.
 *
 * `doctor` is the adoption surface: it reports what oat cannot test against this spec and names
 * the meta tag that would close each gap. A backend team's path to full coverage is to run it
 * and work the list down.
 */

import type { EntityModel, SpecModel } from "../spec/graph.ts"

/**
 * Which checks each tag makes possible, measured rather than estimated.
 *
 * `oat conformance` runs the reference backend twice — once with its tags, once with them
 * stripped — and asserts this map matches the difference, so it cannot drift into marketing.
 *
 * The distinction below is the honest part. Some tags *unlock* checks that are otherwise
 * impossible: nothing in a document reveals that a 202 is a receipt, or that a column is a
 * tombstone. Others do not change how much runs at all — they change whether what runs is
 * trustworthy. Without `x-query`, oat assumes every scalar property is filterable and probes
 * fields the backend may never have indexed; without `x-tenant`, a matching path parameter still
 * infers a tenant and a cross-tenant read is an ambiguity; with no tenant at all the check does
 * not apply.
 */
export const TAG_UNLOCKS: Record<string, readonly string[]> = {
	"x-async": ["async.reaches-terminal-state", "async.receipt-identifies-the-job"],
	"x-effects": ["effects.declared-effect-occurs"],
	"x-immutable": ["patch.immutable-field-rejected"],
	"x-invalidate": ["invalidation.declared-route-changes"],
	/* Declaring filterable fields is itself a claim, and a claim is testable: oat probes each
	 * one and reports the document — not the backend — when a declared filter is refused. */
	"x-query": [
		"spec.declared-filterable-is-filterable",
		"spec.declared-sortable-is-sortable",
		"spec.declared-selectable-is-selectable",
	],
	"x-soft-delete": ["softdelete.absent-from-default-list"],
	"x-invite": ["auth.invite-grants-then-revokes"],
}

/** Tags that change the *confidence* of checks that already run, not the count. */
const TAG_SHARPENS: Record<string, string> = {
	"x-query":
		"the remaining query checks run against every scalar property, including fields the " +
		"backend never indexed — expect findings you will have to dismiss",
	"x-tenant":
		"an inferred tenant makes a cross-tenant read an ambiguity, not a security finding; " +
		"with no tenant tagged or inferred the check does not apply",
}

const TAG_REMEDY: Record<string, string> = {
	"x-async": "declare the poll route so the operation's real outcome can be observed",
	"x-entity": "name the entity and action so this operation joins a lifecycle",
	"x-entity.identity": "name the property identifying an instance",
	"x-invalidate": "list the read routes this mutation must change",
	"x-query": "declare which fields support the filter / order / search / select roles",
	"x-tenant": "name the path parameter that scopes this operation to a tenant",
	"x-invite": "name the invite, accept and revoke operations for delegated access",
}

function bar(value: number, total: number, width = 24): string {
	if (total === 0) return "─".repeat(width)
	const filled = Math.round((value / total) * width)
	return "█".repeat(filled) + "░".repeat(width - filled)
}

function lifecycleGlyphs(entity: EntityModel): string {
	const slots: Array<[string, string | undefined]> = [
		["C", entity.create],
		["L", entity.list],
		["R", entity.read],
		["U", entity.update],
		["D", entity.delete],
	]
	return slots.map(([letter, opId]) => (opId === undefined ? "·" : letter)).join("")
}

function plan(model: SpecModel, asJson: boolean): string {
	if (asJson) {
		return `${JSON.stringify(
			{
				entities: [...model.entities.values()],
				operations: model.operations,
				roots: model.roots,
			},
			null,
			2,
		)}\n`
	}

	const lines: string[] = []
	const entities = [...model.entities.values()].sort((a, b) => a.name.localeCompare(b.name))

	lines.push("")
	lines.push(`  ${model.operations.length} operations · ${entities.length} entities`)
	lines.push("")
	lines.push("  entity              CLRUD  ident      read surface")
	lines.push("  ─────────────────────────────────────────────────────────────────────")
	for (const entity of entities) {
		const surface =
			entity.readSurface.length === 0
				? "— none"
				: `${entity.readSurface.length} route(s)${entity.declaredSurface.length > 0 ? " (declared)" : " (inferred)"}`
		lines.push(
			`  ${entity.name.padEnd(18)}  ${lifecycleGlyphs(entity)}  ${(entity.identity ?? "—").padEnd(9)}  ${surface}`,
		)
		for (const route of entity.readSurface) lines.push(`  ${"".padEnd(38)}${route}`)
	}

	if (model.roots.length > 0) {
		lines.push("")
		lines.push("  roots — no create operation, must be supplied before a run:")
		for (const root of model.roots) lines.push(`    ${root}`)
	}

	const gated = model.operations.filter((op) => op.featureGate !== null)
	if (gated.length > 0) {
		lines.push("")
		lines.push("  feature gates — a matching 403 is coverage, not a defect:")
		for (const op of gated) lines.push(`    ${op.operationId.padEnd(28)} x-feature-gate: ${op.featureGate}`)
	}

	lines.push("")
	return lines.join("\n")
}

function doctor(model: SpecModel, externalRefs: string[], asJson: boolean): { text: string; blocking: number } {
	const entities = [...model.entities.values()].sort((a, b) => a.name.localeCompare(b.name))
	const trackable = entities.filter((e) => e.trackable && e.readSurface.length > 0)
	const listable = trackable.filter((e) => e.list !== undefined)
	const byTag = new Map<string, typeof model.gaps.gaps>()
	for (const gap of model.gaps.gaps) {
		const list = byTag.get(gap.tag) ?? []
		list.push(gap)
		byTag.set(gap.tag, list)
	}

	const blocking = entities.length - trackable.length + (model.roots.length > 0 ? 1 : 0)

	const featureGates = model.operations
		.filter((op) => op.featureGate !== null)
		.map((op) => ({ operationId: op.operationId, featureGate: op.featureGate }))

	if (asJson) {
		return {
			blocking,
			text: `${JSON.stringify(
				{
					blocking,
					entities: entities.length,
					externalRefs,
					featureGates,
					gaps: model.gaps.gaps,
					listableEntities: listable.length,
					roots: model.roots,
					testableEntities: trackable.length,
					trackableEntities: trackable.length,
				},
				null,
				2,
			)}\n`,
		}
	}

	const lines: string[] = []
	lines.push("")
	lines.push(
		`  trackable  ${bar(trackable.length, entities.length)}  ${trackable.length}/${entities.length} ` +
			"entities have an identity and a read",
	)
	lines.push(
		`  listable   ${bar(listable.length, entities.length)}  ${listable.length}/${entities.length} ` +
			(listable.length === 0
				? "entities have a list — query checks will not run"
				: "entities have a list, so query checks can run"),
	)
	lines.push("")

	/*
	 * What the missing tags cost, in checks. A gap list tells an author what oat could not read;
	 * this tells them what they get for fixing it, which is the only form of the message anyone
	 * acts on.
	 */
	const declared = new Set(
		model.operations.flatMap((op) => [
			...(op.async === null ? [] : ["x-async"]),
			...(op.effects.length > 0 ? ["x-effects"] : []),
			...(op.immutable.length > 0 ? ["x-immutable"] : []),
			...(op.invalidates.length > 0 ? ["x-invalidate"] : []),
			...(op.softDelete === null ? [] : ["x-soft-delete"]),
			...(op.tenantSource === "tag" ? ["x-tenant"] : []),
			...(op.query?.source === "tag" ? ["x-query"] : []),
		]),
	)
	for (const entity of entities) {
		if (entity.invite !== null) declared.add("x-invite")
	}
	const lockedTags = Object.keys(TAG_UNLOCKS).filter((tag) => !declared.has(tag))
	const lockedChecks = lockedTags.flatMap((tag) => TAG_UNLOCKS[tag] ?? [])
	if (lockedChecks.length > 0) {
		lines.push(`  ${lockedChecks.length} check(s) cannot run against this document`)
		for (const tag of lockedTags) {
			lines.push(`    ${tag.padEnd(16)} would enable ${(TAG_UNLOCKS[tag] ?? []).join(", ")}`)
		}
		lines.push("")
	}
	const inferredTenant = model.operations.some((op) => op.tenantSource !== null)
	const vague = Object.keys(TAG_SHARPENS).filter((tag) => {
		if (declared.has(tag)) return false
		if (tag === "x-query") return listable.length > 0
		if (tag === "x-tenant") return inferredTenant
		return true
	})
	if (vague.length > 0) {
		lines.push("  running, but on inferred information")
		for (const tag of vague) {
			lines.push(`    ${tag.padEnd(16)} ${TAG_SHARPENS[tag] ?? ""}`)
		}
		lines.push("")
	}

	const untrackable = entities.filter((e) => !trackable.includes(e))
	if (untrackable.length > 0) {
		lines.push("  not trackable")
		for (const entity of untrackable) {
			const reason =
				entity.identity === null
					? "no identity property — instances cannot be tracked across projections"
					: "no read surface — mutations cannot be verified"
			lines.push(`    ${entity.name.padEnd(20)} ${reason}`)
		}
		lines.push("")
	}
	const itemOnly = trackable.filter((e) => e.list === undefined)
	if (itemOnly.length > 0) {
		lines.push("  no list — query, pagination and count checks will not run")
		for (const entity of itemOnly) {
			const route = entity.read ?? entity.readSurface[0] ?? "item route only"
			lines.push(`    ${entity.name.padEnd(20)} ${route}`)
		}
		lines.push("")
	}

	if (model.roots.length > 0) {
		lines.push("  roots required in config (no create operation in this document)")
		for (const root of model.roots) lines.push(`    ${root}`)
		lines.push("")
	}

	if (featureGates.length > 0) {
		lines.push("  feature gates — a matching 403 is a coverage gap, not a fail")
		for (const gate of featureGates) {
			lines.push(`    ${gate.operationId.padEnd(28)} x-feature-gate: ${gate.featureGate}`)
		}
		lines.push("")
	}

	if (!model.hasAuthOperations && model.securitySchemes.length > 0) {
		lines.push("  auth")
		lines.push(`    document declares ${model.securitySchemes.map((s) => `"${s}"`).join(", ")} but contains no`)
		lines.push("    operation for obtaining a credential. No generic client can bootstrap from")
		lines.push("    this spec. Add the auth operations, or declare x-auth-flows at document root.")
		lines.push("")
	}

	if (externalRefs.length > 0) {
		lines.push("  unresolved external $refs (not fetched — a test tool should not follow arbitrary URLs)")
		for (const ref of externalRefs) lines.push(`    ${ref}`)
		lines.push("")
	}

	if (byTag.size > 0) {
		lines.push("  gaps by tag")
		const sorted = [...byTag.entries()].sort((a, b) => b[1].length - a[1].length)
		for (const [tag, gapList] of sorted) {
			const remedy = TAG_REMEDY[tag] ?? "see the README"
			lines.push(`    ${tag} (${gapList.length}) — ${remedy}`)
			for (const gap of gapList.slice(0, 4)) {
				lines.push(`      ${gap.operationId}: ${gap.detail}`)
			}
			if (gapList.length > 4) lines.push(`      … and ${gapList.length - 4} more`)
		}
		lines.push("")
	}

	if (blocking === 0 && byTag.size === 0) lines.push("  no gaps — full coverage available\n")

	return { blocking, text: lines.join("\n") }
}

export const report = { doctor, plan }
