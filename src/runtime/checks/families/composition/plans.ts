import { filterTerm } from "../../../../spec/conventions/filter.ts"
import { selectTerm } from "../../../../spec/conventions/select.ts"
import { idOf, type Record_ } from "../../../world.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, type Plan, ready } from "../../core/plan.ts"
import { conv } from "../../query/capabilities.ts"
import { cohortFact } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"

/** A filter selecting a proper subset of the cohort, and the record it was built from. */
export interface Subset {
	field: string
	target: Record_
	term: Record<string, string>
}

/**
 * A field, and a value on it, selecting a *proper subset* of the cohort: more than one record so
 * there is something to reorder or project, and fewer than all so a dropped predicate is visible
 * as a change in membership. A value matching everything would make the filtered and unfiltered
 * sets identical, and a composition check would pass whatever the backend did.
 */
export function subsetPlan(ctx: CheckContext): Plan<Subset> {
	const picked = properSubsetFilter(ctx)
	if (picked === null) return cannot("a filterable value shared by several cohort records but not all of them")
	const term = filterTerm(conv(ctx), picked.field, "eq", String(picked.target[picked.field]))
	return term === null
		? cannot(`a filter grammar that can express equality on "${picked.field}"`)
		: ready({ ...picked, term })
}

/** A proper-subset filter and a search token that overlap without nesting. */
export function overlapPlan(ctx: CheckContext): Plan<Subset & { token: string }> {
	const picked = overlappingFilterAndSearch(ctx)
	if (picked === null) return cannot("a filterable value and a search token that overlap without nesting")
	const term = filterTerm(conv(ctx), picked.field, "eq", String(picked.target[picked.field]))
	return term === null
		? cannot(`a filter grammar that can express equality on "${picked.field}"`)
		: ready({ ...picked, term })
}

/** A sparse fieldset of the identity and one other selectable field. */
export function projectionBeside(ctx: CheckContext): { extra: string; projection: Record<string, string> } | null {
	const extra = (ctx.query?.selectable ?? []).find((name) => name !== ctx.identity) ?? ctx.identity
	const projection = selectTerm(conv(ctx), [ctx.identity, extra], ctx.entityName)
	return projection === null ? null : { extra, projection }
}

/** `projectionBeside` as a plan: it stands down when the select grammar cannot write a fieldset. */
export function projectionPlan(ctx: CheckContext): Plan<{ extra: string; projection: Record<string, string> }> {
	const projected = projectionBeside(ctx)
	return projected === null ? cannot("a select grammar that can express a sparse fieldset") : ready(projected)
}

/** The sparse fieldset `requested` as a plan: it stands down, unexplained, when no select can write it. */
export function selectionPlan(ctx: CheckContext, requested: readonly string[]): Plan<Record<string, string>> {
	const projection = selectTerm(conv(ctx), requested, ctx.entityName)
	return projection === null ? cannot() : ready(projection)
}

/** A sortable field other than `field` and the identity, else the identity. */
export function sortFieldBeside(ctx: CheckContext, field: string): string {
	return (ctx.query?.sortable ?? []).find((name) => name !== field && name !== ctx.identity) ?? ctx.identity
}

/** A filterable field whose value selects a proper subset of the cohort. */
function properSubsetFilter(ctx: CheckContext): { field: string; target: Record_ } | null {
	return cohortFact(ctx, "proper-subset", () => findProperSubset(ctx))
}

function findProperSubset(ctx: CheckContext): { field: string; target: Record_ } | null {
	for (const candidate of ctx.query?.filterable ?? []) {
		if (candidate === ctx.identity) continue
		const values = ctx.records.map((record) => JSON.stringify(record[candidate]))
		const match = ctx.records.find((record) => {
			if (record[candidate] === null || record[candidate] === undefined) return false
			const count = values.filter((v) => v === JSON.stringify(record[candidate])).length
			return count > 1 && count < ctx.records.length
		})
		if (match !== undefined) return { field: candidate, target: match }
	}
	return null
}

/**
 * A filter value and a search token that overlap without nesting, so dropping either axis
 * changes the intersection.
 */
function overlappingFilterAndSearch(ctx: CheckContext): { field: string; target: Record_; token: string } | null {
	return cohortFact(ctx, "overlap", () => findOverlap(ctx))
}

function findOverlap(ctx: CheckContext): { field: string; target: Record_; token: string } | null {
	if (ctx.query === null) return null
	const searchable = ctx.query.searchable
	for (const candidate of ctx.query.filterable) {
		if (candidate === ctx.identity) continue
		const groups = new Map<string, Record_[]>()
		for (const record of ctx.records) {
			if (record[candidate] === null || record[candidate] === undefined) continue
			const key = JSON.stringify(record[candidate])
			const group = groups.get(key) ?? []
			group.push(record)
			groups.set(key, group)
		}
		for (const group of groups.values()) {
			if (group.length <= 1 || group.length >= ctx.records.length) continue
			const found = overlappingSearchToken(ctx, searchable, new Set(ids(group, ctx.identity)))
			if (found === null) continue
			/* A group of more than one record has a first. */
			return { field: candidate, target: group[0] as Record_, token: found }
		}
	}
	return null
}

/**
 * A search token that overlaps a filtered set without nesting — each side matches something
 * the other does not, so dropping either axis changes the intersection.
 */
function overlappingSearchToken(ctx: CheckContext, fields: readonly string[], filterIds: Set<string>): string | null {
	if (fields.length === 0) return null

	const matches = (token: string): Set<string> => {
		const needle = token.toLowerCase()
		const hit = new Set<string>()
		for (const record of ctx.records) {
			if (
				fields.some((field) =>
					String(record[field] ?? "")
						.toLowerCase()
						.includes(needle),
				)
			) {
				const key = idOf(record, ctx.identity)
				if (key !== undefined) hit.add(key)
			}
		}
		return hit
	}

	const candidates: string[] = []
	for (const record of ctx.records) {
		for (const name of fields) {
			const value = record[name]
			if (typeof value !== "string" || value.length < 2) continue
			candidates.push(value)
			if (value.length >= 3) candidates.push(value.slice(0, 3))
			for (const word of value.split(/\s+/)) {
				if (word.length >= 2) candidates.push(word)
			}
		}
	}

	for (const token of candidates) {
		const searchIds = matches(token)
		const inter = [...searchIds].filter((id) => filterIds.has(id)).length
		const onlySearch = [...searchIds].filter((id) => !filterIds.has(id)).length
		const onlyFilter = [...filterIds].filter((id) => !searchIds.has(id)).length
		if (inter > 0 && onlySearch > 0 && onlyFilter > 0) return token
	}
	return null
}
