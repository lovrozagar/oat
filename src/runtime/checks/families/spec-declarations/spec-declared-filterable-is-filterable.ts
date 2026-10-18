import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions/filter.ts"
import type { EffectiveFilterField } from "../../../../spec/query/effective.ts"
import { FILTER_OPS } from "../../../../spec/query/ops.ts"
import type { Exchange } from "../../../exchange.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { filterSentinel } from "../../../generate.ts"
import type { CheckContext } from "../../core/context.ts"
import { when } from "../../core/plan.ts"
import { declarationAnswer } from "../../planning/declarations.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { asTermValue, canUseOp, conv, q, resolvedCaps, schemaType } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

/**
 * A capability the document declares must actually exist.
 *
 * `x-query.filterable` is a promise: every client generated from that document will offer a filter
 * on each field named there. When the backend rejects one, the backend is not necessarily wrong —
 * it is entitled to refuse a column it never indexed — but the *document* is, and it is wrong in
 * the most expensive way, because the failure only appears at runtime in someone else's client.
 *
 * oat is uniquely positioned to catch this: it is the only thing that reads the claim and then
 * tries it. Note the verdict is SPEC_BUG rather than BACKEND_BUG — the fix is to correct the
 * document or index the column, and saying which is not oat's call.
 *
 * This also closes a silent-skip: every filter check treats a 4xx as a capability statement and
 * stands down, which is right when the field was merely inferred and wrong when it was declared.
 */
export const declaredFilterableWorks = defineCheck({
	plan: (ctx) =>
		when(
			conv(ctx).filter !== undefined &&
				ctx.query?.source === "tag" &&
				(ctx.query?.filterable.length ?? 0) > 0 &&
				ctx.records.length > 0,
		),
	dependsOn: [
		"list.read-after-write",
		/* The evidence is a *rejection*. A backend that silently drops unknown filter fields never
		 * rejects anything, so an overclaimed field comes back 200 and this check would report the
		 * document as honest — the dropped-filter defect is the finding to act on first. */
		"filter.unknown-field-rejected",
		/* And only a 4xx counts: a backend whose filter parser throws answers *every* bad filter
		 * with a 500, which makes "the document declared a field the backend refuses"
		 * indistinguishable from "the parser is broken". That is the finding to fix first. */
		"error.malformed-filter-not-5xx",
	],
	id: "spec.declared-filterable-is-filterable",
	needs: "x-query naming filterable fields",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const conventions = conv(ctx)
		const rejected: Array<{ field: string; status: number; exchange: Exchange }> = []
		const unknown: string[] = []
		let probed = 0

		/* Every field at once; the answers are judged in declaration order. */
		const answers = await Promise.all(
			(ctx.query?.filterable ?? []).map(async (field) => {
				/* A declared field that never appears on the cohort is still a promise — often the
				 * most expensive kind, a column the document invented. It is probed with an operator
				 * the field allows and a value of the field's own type: a backend that rejects a
				 * string compared with a number is right to, and that says nothing about the field. */
				const probe = capabilityProbe(ctx, field)
				if (probe === null) return null
				const term = filterTerm(conventions, field, probe.op, probe.value)
				if (term === null) return null
				return { field, result: await list(ctx, { ...q(ctx, { limit: 5 }), ...term }) }
			}),
		)
		for (const answered of answers) {
			if (answered === null) continue
			const { field, result } = answered
			probed += 1
			/* Only a rejection counts. A filter that returns the wrong rows is a backend defect
			 * other checks own; this one is strictly about the capability existing. */
			const answer = declarationAnswer(result.exchange.status)
			if (answer === "refused") rejected.push({ exchange: result.exchange, field, status: result.exchange.status })
			if (answer === "unknown") unknown.push(`${field} (${result.exchange.status})`)
		}

		if (probed === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no declared filterable field holds a non-null value in the cohort, so none could be probed",
			)
		}
		if (rejected.length === 0 && unknown.length > 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`probes were turned away without a verdict: ${unknown.join(", ")}`,
			)
		}
		if (rejected.length === 0) return ASSERTED

		return ctx.findings.spec(
			this.id,
			ctx.entityName,
			"the document declares a filter the backend does not accept",
			`x-query lists ${rejected.length} field(s) as filterable that the backend rejects: ` +
				`${rejected.map((r) => `${r.field} (${r.status})`).join(", ")}. ` +
				"Every client generated from this document will offer a filter that fails at runtime. " +
				"Either the column needs an index or the declaration needs removing — but the " +
				"document and the backend currently disagree about what this API can do.",
			rejected.slice(0, 3).map((item) => item.exchange),
		)
	},
})

/** What a capability probe sends: an operator and a value for it. */
type Probe = { op: (typeof FILTER_OPS)[number]; value: string | number | boolean }

/**
 * An operator the field allows and a value of the field's own type, to ask whether a declared
 * filter exists at all. Equality where it is allowed; membership for an array.
 */
function capabilityProbe(ctx: CheckContext, name: string): Probe | null {
	const caps = resolvedCaps(ctx)
	const field = caps.filterable.find((item) => item.field === name) ?? { field: name }
	const type = field.type ?? schemaType(ctx, name)
	const sample = ctx.records.find((record) => record[name] !== null && record[name] !== undefined)?.[name]
	if (type === "array") return membershipProbe(ctx, field, sample)
	return equalityProbe(ctx, field, type, sample)
}

/** The item schema's declaration of property `name`, when it has one. */
function propertySchemaOf(ctx: CheckContext, name: string): Record<string, unknown> | undefined {
	return (ctx.listOp.collection?.itemSchema?.properties as Record<string, Record<string, unknown>> | undefined)?.[name]
}

/** `contains` with an element the cohort holds, or else one drawn from the array's item schema. */
function membershipProbe(ctx: CheckContext, field: EffectiveFilterField, sample: unknown): Probe | null {
	if (!canUseOp(ctx, field, "contains")) return null
	const element = Array.isArray(sample) ? sample[0] : undefined
	if (element !== undefined) return { op: "contains", value: asTermValue(element) }
	const items = propertySchemaOf(ctx, field.field)?.items
	const sentinel = filterSentinel(items ?? { type: "string" }, ctx.nonce)
	return sentinel.ok ? { op: "contains", value: asTermValue(sentinel.value) } : null
}

/** `eq` with a scalar the cohort holds, or else a sentinel of the field's own type. */
function equalityProbe(
	ctx: CheckContext,
	field: EffectiveFilterField,
	type: string | undefined,
	sample: unknown,
): Probe | null {
	if (!canUseOp(ctx, field, "eq")) return null
	if (sample !== undefined && typeof sample !== "object") return { op: "eq", value: asTermValue(sample) }
	const sentinel = filterSentinel(propertySchemaOf(ctx, field.field) ?? { type: type ?? "string" }, ctx.nonce)
	if (sentinel.ok && isScalar(sentinel.value)) return { op: "eq", value: sentinel.value }
	return null
}

function isScalar(value: unknown): value is string | number | boolean {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}
