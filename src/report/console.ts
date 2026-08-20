/**
 * Console renderers for the offline commands.
 *
 * `doctor` is the adoption surface: it reports what oat cannot test against this spec and names
 * the meta tag that would close each gap. A backend team's path to full coverage is to run it
 * and work the list down.
 */

import type { EntityConfig, OatConfig, QueryCapabilities } from "../config/define-config.ts"
import { formatUniqueSets } from "../spec/extensions.ts"
import type { EntityModel, SpecModel } from "../spec/graph.ts"
import { canWriteFilterOp } from "../spec/conventions.ts"
import {
	anyFieldAllows,
	fieldAllowsNulls,
	mergeQueryCapabilities,
	opsAreClosed,
	type EffectiveQueryCapabilities,
} from "../spec/query-capabilities.ts"

export interface DoctorConfig {
	query?: QueryCapabilities
	entities?: Record<string, EntityConfig>
	hooks?: Pick<NonNullable<OatConfig["hooks"]>, "resolveQueryCapabilities">
}

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
		"spec.declared-filterable-ops-accepted",
		"spec.declared-filterable-illegal-op-rejected",
		"spec.declared-sortable-nulls-accepted",
		"filter.in-is-union-of-eq",
		"filter.nin-complements-in",
		"filter.ilike-is-case-insensitive",
		"filter.is-null-selects-nulls",
		"filter.alias-matches-canonical",
		"filter.illegal-op-rejected",
		"filter.empty-in",
		"filter.in-over-limit-rejected",
		"filter.condition-cap-rejected",
		"sort.nulls-first-last",
		"sort.stable-tiebreak",
		"search.empty-q",
		"select.unknown-field-rejected",
	],
	"x-soft-delete": ["softdelete.absent-from-default-list"],
	"x-invite": ["auth.invite-grants-then-revokes"],
	"x-unique": ["create.unique-conflict-rejected", "update.unique-conflict-rejected"],
}

/** Tags that change the *confidence* of checks that already run, not the count. */
const TAG_SHARPENS: Record<string, string> = {
	"x-query":
		"the remaining query checks run against every scalar property, including fields the " +
		"backend never indexed — expect findings you will have to dismiss",
	"x-tenant":
		"an inferred tenant makes a cross-tenant item or filter read an ambiguity, not a " +
		"security finding; with no tenant tagged or inferred those checks do not apply",
}

const TAG_REMEDY: Record<string, string> = {
	"x-async": "declare the poll route so the operation's real outcome can be observed",
	"x-entity": "name the entity and action so this operation joins a lifecycle",
	"x-entity.identity": "name the property identifying an instance",
	"x-invalidate": "list the read routes this mutation must change",
	"x-query": "declare which fields support the filter / order / search / select roles",
	"x-tenant": "name the path parameter that scopes this operation to a tenant",
	"x-invite": "name the invite, accept and revoke operations for delegated access",
	"x-wait": "name the GET to poll after this write until a JSON path is occupied",
	"x-effects": "declare create/append/delete with count or min, not both",
	"x-unique": "declare the column sets that must stay unique so a 409 duplicate can be scored",
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
				unique: [...model.entities.values()]
					.filter((entity) => entity.unique !== null)
					.map((entity) => ({ entity: entity.name, unique: entity.unique })),
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

	const uniqued = entities.filter((entity) => entity.unique !== null)
	if (uniqued.length > 0) {
		lines.push("")
		lines.push("  unique constraints — a 409 on a duplicate of these columns is a pass:")
		for (const entity of uniqued) {
			lines.push(`    ${entity.name.padEnd(28)} x-unique: ${formatUniqueSets(entity.unique)}`)
		}
	}

	lines.push("")
	return lines.join("\n")
}

function catalogCheckPreview(
	caps: EffectiveQueryCapabilities,
	list: { conventions: { grammar: string; order?: string; select?: string; search?: string; searchMode?: string } },
	source: "tag" | "heuristic" | "config" | "mixed",
): string[] {
	const ids: string[] = []
	const grammar = { grammar: list.conventions.grammar } as Parameters<typeof canWriteFilterOp>[0]
	const write = (op: Parameters<typeof canWriteFilterOp>[1]): boolean => canWriteFilterOp(grammar, op)
	if (anyFieldAllows(caps, "in") && write("in")) ids.push("filter.in-is-union-of-eq")
	if (anyFieldAllows(caps, "in") && anyFieldAllows(caps, "nin") && write("in") && write("nin")) {
		ids.push("filter.nin-complements-in")
	}
	if (anyFieldAllows(caps, "gte") && anyFieldAllows(caps, "gt") && write("gte")) ids.push("filter.gte-is-gt-or-eq")
	if (anyFieldAllows(caps, "lte") && anyFieldAllows(caps, "lt") && write("lte")) ids.push("filter.lte-is-lt-or-eq")
	if (anyFieldAllows(caps, "lt") && anyFieldAllows(caps, "gt") && write("lt"))
		ids.push("filter.ordered-triple-partitions")
	if (anyFieldAllows(caps, "ilike") && anyFieldAllows(caps, "like") && write("ilike")) {
		ids.push("filter.ilike-is-case-insensitive")
	}
	if (anyFieldAllows(caps, "is") && write("is")) ids.push("filter.is-null-selects-nulls")
	if (anyFieldAllows(caps, "contains") && write("contains")) ids.push("filter.contains-membership")
	if (list.conventions.grammar === "postgrest" && caps.filterable.length > 1) {
		ids.push("filter.nested-and-or-distributes")
	}
	if (Object.keys(caps.aliases).length > 0) ids.push("filter.alias-matches-canonical")
	if (caps.filterable.some((field) => opsAreClosed(field, caps))) {
		ids.push("filter.illegal-op-rejected")
		if (source === "tag" || source === "mixed") {
			ids.push("spec.declared-filterable-ops-accepted", "spec.declared-filterable-illegal-op-rejected")
		}
	}
	if (caps.emptyIn !== undefined && anyFieldAllows(caps, "in") && write("in")) ids.push("filter.empty-in")
	if (caps.maxInValues !== undefined && anyFieldAllows(caps, "in") && write("in"))
		ids.push("filter.in-over-limit-rejected")
	if (caps.maxFilterConditions !== undefined && list.conventions.grammar === "postgrest") {
		ids.push("filter.condition-cap-rejected")
	}
	if (list.conventions.order !== undefined) {
		ids.push("sort.unknown-field-rejected")
		if (caps.sortable.some((field) => field.type === "number")) ids.push("sort.numeric-order-is-numeric")
		if (
			caps.sortable.some((field) => fieldAllowsNulls(field, caps, "first") || fieldAllowsNulls(field, caps, "last"))
		) {
			ids.push("sort.nulls-first-last", "spec.declared-sortable-nulls-accepted")
		}
		if (caps.sortable.length >= 2 && (caps.sort?.maxKeys === undefined || caps.sort.maxKeys >= 2)) {
			ids.push("sort.multi-key-tiebreak")
		}
		if (caps.sort?.defaultOrder !== undefined) ids.push("sort.default-order-applied")
		if (caps.sort?.stableTiebreak !== undefined) ids.push("sort.stable-tiebreak")
	}
	if (list.conventions.search !== undefined && caps.searchable.length > 0) {
		ids.push("search.tokens-and", "search.case-insensitive", "search.undeclared-field-not-required")
		if (caps.searchEmpty !== undefined) ids.push("search.empty-q")
		if (caps.searchModes !== undefined && list.conventions.searchMode !== undefined) {
			ids.push("search.mode-accepted")
			if (caps.searchModes.length >= 2) ids.push("search.modes-differ")
		}
	}
	if (list.conventions.select !== undefined && caps.selectable.length > 0) {
		ids.push("select.requested-fields-present")
		if (caps.select?.unknown !== undefined) ids.push("select.unknown-field-rejected")
		if (caps.select?.nested === true && (caps.select.relations?.length ?? 0) > 0) ids.push("select.nested-honoured")
	}
	if (
		list.conventions.order !== undefined &&
		list.conventions.select !== undefined &&
		caps.sortable.length > 0 &&
		caps.selectable.length > 0
	) {
		ids.push("query.sort-and-select-compose")
	}
	if (
		list.conventions.search !== undefined &&
		list.conventions.select !== undefined &&
		caps.searchable.length > 0 &&
		caps.selectable.length > 0
	) {
		ids.push("query.search-and-select-compose")
	}
	if (
		list.conventions.search !== undefined &&
		list.conventions.order !== undefined &&
		caps.searchable.length > 0 &&
		caps.sortable.length > 0
	) {
		ids.push("query.search-and-sort-compose")
	}
	if (
		caps.filterable.length > 0 &&
		caps.searchable.length > 0 &&
		caps.sortable.length > 0 &&
		caps.selectable.length > 0
	) {
		ids.push("query.filter-search-sort-select-compose")
	}
	return ids
}

function entityQueryCatalogs(model: SpecModel, config?: DoctorConfig) {
	const unknownEntities = Object.keys(config?.entities ?? {}).filter((name) => !model.entities.has(name))
	const hook = config?.hooks?.resolveQueryCapabilities !== undefined
	const catalogs: Array<{
		entity: string
		source: EffectiveQueryCapabilities["source"]
		filterable: EffectiveQueryCapabilities["filterable"]
		sortable: EffectiveQueryCapabilities["sortable"]
		searchable: string[]
		selectable: string[]
		operators?: EffectiveQueryCapabilities["operators"]
		operatorsByType?: EffectiveQueryCapabilities["operatorsByType"]
		aliases: EffectiveQueryCapabilities["aliases"]
		identityFilter?: string
		emptyIn?: EffectiveQueryCapabilities["emptyIn"]
		maxInValues?: number
		maxFilterConditions?: number
		searchModes?: string[]
		searchEmpty?: EffectiveQueryCapabilities["searchEmpty"]
		sort?: EffectiveQueryCapabilities["sort"]
		select?: EffectiveQueryCapabilities["select"]
		harvest: string[]
		hook: boolean
		checks: string[]
	}> = []
	for (const entity of [...model.entities.values()].sort((a, b) => a.name.localeCompare(b.name))) {
		if (entity.list === undefined) continue
		const listOp = model.byOperationId.get(entity.list)
		if (listOp === undefined) continue
		const entityQuery = config?.entities?.[entity.name]?.query
		const caps = mergeQueryCapabilities({
			itemSchema: listOp.collection?.itemSchema ?? null,
			tag: listOp.query,
			...(config?.query === undefined ? {} : { global: config.query }),
			...(entityQuery === undefined ? {} : { entity: entityQuery }),
		})
		const harvest = [
			caps.filterableFrom === undefined ? "" : "filterableFrom",
			caps.sortableFrom === undefined ? "" : "sortableFrom",
			caps.searchableFrom === undefined ? "" : "searchableFrom",
			caps.selectableFrom === undefined ? "" : "selectableFrom",
		].filter(Boolean)
		catalogs.push({
			aliases: caps.aliases,
			checks: catalogCheckPreview(caps, listOp, caps.source),
			entity: entity.name,
			filterable: caps.filterable,
			harvest,
			hook,
			searchable: caps.searchable,
			selectable: caps.selectable,
			sortable: caps.sortable,
			source: caps.source,
			...(caps.operators === undefined ? {} : { operators: caps.operators }),
			...(caps.operatorsByType === undefined ? {} : { operatorsByType: caps.operatorsByType }),
			...(caps.identityFilter === undefined ? {} : { identityFilter: caps.identityFilter }),
			...(caps.emptyIn === undefined ? {} : { emptyIn: caps.emptyIn }),
			...(caps.maxInValues === undefined ? {} : { maxInValues: caps.maxInValues }),
			...(caps.maxFilterConditions === undefined ? {} : { maxFilterConditions: caps.maxFilterConditions }),
			...(caps.searchModes === undefined ? {} : { searchModes: caps.searchModes }),
			...(caps.searchEmpty === undefined ? {} : { searchEmpty: caps.searchEmpty }),
			...(caps.sort === undefined ? {} : { sort: caps.sort }),
			...(caps.select === undefined ? {} : { select: caps.select }),
		})
	}
	return { catalogs, unknownEntities }
}

function doctor(
	model: SpecModel,
	externalRefs: string[],
	asJson: boolean,
	config?: DoctorConfig,
): { text: string; blocking: number } {
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
	const uniqueConstraints = entities
		.filter((entity) => entity.unique !== null)
		.map((entity) => ({ entity: entity.name, unique: entity.unique }))
	const { catalogs, unknownEntities } = entityQueryCatalogs(model, config)

	if (asJson) {
		return {
			blocking,
			text: `${JSON.stringify(
				{
					blocking,
					entities: entities.length,
					externalRefs,
					featureGates,
					uniqueConstraints,
					gaps: model.gaps.gaps,
					listableEntities: listable.length,
					queryCatalog: catalogs,
					roots: model.roots,
					testableEntities: trackable.length,
					trackableEntities: trackable.length,
					unknownEntities,
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
			...(op.wait === null ? [] : ["x-wait"]),
			...(op.tenantSource === "tag" ? ["x-tenant"] : []),
			...(op.query?.source === "tag" ? ["x-query"] : []),
			...(op.unique !== null ? ["x-unique"] : []),
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

	if (uniqueConstraints.length > 0) {
		lines.push("  unique constraints — a 409 on a duplicate of these columns is a pass")
		for (const row of uniqueConstraints) {
			lines.push(`    ${row.entity.padEnd(28)} x-unique: ${formatUniqueSets(row.unique)}`)
		}
		lines.push("")
	}

	if (unknownEntities.length > 0) {
		lines.push("  config.entities names that do not match the document (ignored)")
		for (const name of unknownEntities) lines.push(`    ${name}`)
		lines.push("")
	}

	if (catalogs.length > 0) {
		lines.push("  query catalog (declared or skip — missing capability does not apply)")
		for (const row of catalogs) {
			const ops = row.operators === undefined ? "implicit eq/neq/gt/gte/lt/lte/like" : row.operators.join(",")
			lines.push(
				`    ${row.entity}  source=${row.source}${row.hook ? " +hook" : ""}${row.harvest.length > 0 ? ` harvest=${row.harvest.join(",")}` : ""}`,
			)
			lines.push(`      filterable  ${row.filterable.map((field) => field.field).join(", ") || "—"}  ops ${ops}`)
			lines.push(`      sortable    ${row.sortable.map((field) => field.field).join(", ") || "—"}`)
			lines.push(`      searchable  ${row.searchable.join(", ") || "—"}`)
			lines.push(`      selectable  ${row.selectable.join(", ") || "—"}`)
			const extras = [
				row.identityFilter === undefined ? "" : `identityFilter=${row.identityFilter}`,
				row.emptyIn === undefined ? "" : `emptyIn=${row.emptyIn}`,
				row.maxInValues === undefined ? "" : `maxInValues=${row.maxInValues}`,
				row.maxFilterConditions === undefined ? "" : `maxFilterConditions=${row.maxFilterConditions}`,
				row.searchEmpty === undefined ? "" : `searchEmpty=${row.searchEmpty}`,
				row.searchModes === undefined ? "" : `searchModes=${row.searchModes.join(",")}`,
				row.sort?.nulls === undefined ? "" : `sort.nulls=${row.sort.nulls.join(",")}`,
				row.sort?.maxKeys === undefined ? "" : `sort.maxKeys=${row.sort.maxKeys}`,
				row.sort?.defaultOrder === undefined ? "" : `defaultOrder=${row.sort.defaultOrder}`,
				row.sort?.stableTiebreak === undefined ? "" : `stableTiebreak=${row.sort.stableTiebreak}`,
				row.select?.unknown === undefined ? "" : `select.unknown=${row.select.unknown}`,
				row.select?.nested === undefined ? "" : `select.nested=${String(row.select.nested)}`,
			].filter(Boolean)
			if (extras.length > 0) lines.push(`      ${extras.join("  ")}`)
			if (row.checks.length > 0) {
				lines.push(`      will apply  ${row.checks.join(", ")}`)
			} else {
				lines.push("      will apply  (none of the declared-or-skip catalog checks)")
			}
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
