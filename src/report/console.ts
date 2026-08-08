/**
 * Console renderers for the offline commands.
 *
 * `doctor` is the adoption surface: it reports what oat cannot test against this spec and names
 * the meta tag that would close each gap. A backend team's path to full coverage is to run it
 * and work the list down.
 */

import type { EntityModel, SpecModel } from "../spec/graph.ts"

const TAG_REMEDY: Record<string, string> = {
	"x-async": "declare the poll route so the operation's real outcome can be observed",
	"x-entity": "name the entity and action so this operation joins a lifecycle",
	"x-entity.identity": "name the property identifying an instance",
	"x-invalidate": "list the read routes this mutation must change",
	"x-query": "declare which fields support filter / order / q / select",
	"x-tenant": "name the path parameter that scopes this operation to a tenant",
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

	lines.push("")
	return lines.join("\n")
}

function doctor(
	model: SpecModel,
	externalRefs: string[],
	asJson: boolean,
): { text: string; blocking: number } {
	const entities = [...model.entities.values()].sort((a, b) => a.name.localeCompare(b.name))
	const testable = entities.filter((e) => e.trackable && e.readSurface.length > 0)
	const byTag = new Map<string, typeof model.gaps.gaps>()
	for (const gap of model.gaps.gaps) {
		const list = byTag.get(gap.tag) ?? []
		list.push(gap)
		byTag.set(gap.tag, list)
	}

	const blocking = entities.length - testable.length + (model.roots.length > 0 ? 1 : 0)

	if (asJson) {
		return {
			blocking,
			text: `${JSON.stringify(
				{
					blocking,
					entities: entities.length,
					externalRefs,
					gaps: model.gaps.gaps,
					roots: model.roots,
					testableEntities: testable.length,
				},
				null,
				2,
			)}\n`,
		}
	}

	const lines: string[] = []
	lines.push("")
	lines.push(`  coverage  ${bar(testable.length, entities.length)}  ${testable.length}/${entities.length} entities fully testable`)
	lines.push("")

	const untestable = entities.filter((e) => !testable.includes(e))
	if (untestable.length > 0) {
		lines.push("  not fully testable")
		for (const entity of untestable) {
			const reason =
				entity.identity === null
					? "no identity property — instances cannot be tracked across projections"
					: "no read surface — mutations cannot be verified"
			lines.push(`    ${entity.name.padEnd(20)} ${reason}`)
		}
		lines.push("")
	}

	if (model.roots.length > 0) {
		lines.push("  roots required in config (no create operation in this document)")
		for (const root of model.roots) lines.push(`    ${root}`)
		lines.push("")
	}

	if (!model.hasAuthOperations && model.securitySchemes.length > 0) {
		lines.push("  auth")
		lines.push(
			`    document declares ${model.securitySchemes.map((s) => `"${s}"`).join(", ")} but contains no`,
		)
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
			const remedy = TAG_REMEDY[tag] ?? "see EXTENSIONS.md"
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
