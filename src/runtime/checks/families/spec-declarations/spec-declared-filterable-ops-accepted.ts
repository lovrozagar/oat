import { defineCheck } from "../../core/define.ts"
import { canWriteFilterOp, filterTerm } from "../../../../spec/conventions.ts"
import {
	type EffectiveFilterField,
	FILTER_OPS,
	opsAreClosed,
	opsForField,
} from "../../../../spec/query-capabilities.ts"
import type { Exchange } from "../../../client.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { filterSentinel } from "../../../generate.ts"
import type { CheckContext } from "../../core/context.ts"
import { when } from "../../core/plan.ts"
import { declarationAnswer } from "../../planning/declarations.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { asTermValue, conv, q, resolvedCaps, schemaType } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

function probeValueForOp(
	ctx: CheckContext,
	field: EffectiveFilterField,
	op: (typeof FILTER_OPS)[number],
): string | number | readonly (string | number)[] | null {
	const sample = ctx.records.find((row) => row[field.field] != null)
	if (op === "is") return "null"
	if (op === "contains") {
		const arr = sample?.[field.field]
		if (Array.isArray(arr) && arr[0] !== undefined) return asTermValue(arr[0])
		return "oat-probe"
	}
	/* A value of the field's own type: a backend that rejects a string compared with a date is
	 * right to, and that says nothing about whether the operator is supported. */
	const value = sample === undefined ? typedSentinel(ctx, field) : asTermValue(sample[field.field])
	if (value === null) return null
	return op === "in" || op === "nin" ? [value] : value
}

/** A well-formed value of `field`'s declared type that no record holds, for probing a capability. */
function typedSentinel(ctx: CheckContext, field: EffectiveFilterField): string | number | null {
	const propertySchema = (ctx.listOp.collection?.itemSchema?.properties as Record<string, unknown> | undefined)?.[
		field.field
	]
	const made = filterSentinel(
		propertySchema ?? { type: field.type ?? schemaType(ctx, field.field) ?? "string" },
		ctx.nonce,
	)
	return made.ok && (typeof made.value === "string" || typeof made.value === "number") ? made.value : null
}

export const declaredFilterableOpsAccepted = /* @__PURE__ */ defineCheck({
	plan: (ctx) =>
		when(
			ctx.query?.source === "tag" &&
				resolvedCaps(ctx).filterable.some((field) => opsAreClosed(field, resolvedCaps(ctx))),
		),
	dependsOn: ["list.read-after-write", "spec.declared-filterable-is-filterable", "error.malformed-filter-not-5xx"],
	id: "spec.declared-filterable-ops-accepted",
	needs: "a closed operator list on at least one declared field",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const caps = resolvedCaps(ctx)
		const rejected: string[] = []
		const refusedBy: Exchange[] = []
		const unknown: string[] = []
		const probes: Array<{ label: string; term: Record<string, string> }> = []
		for (const field of caps.filterable) {
			if (!opsAreClosed(field, caps)) continue
			for (const op of opsForField(field, caps)) {
				if (!canWriteFilterOp(conv(ctx), op)) continue
				/* No value of the field's type: a null operand would test nullability, not the operator. */
				const value = probeValueForOp(ctx, field, op)
				if (value === null) continue
				const term = filterTerm(conv(ctx), field.field, op, value)
				if (term !== null) probes.push({ label: `${field.field}.${op}`, term })
			}
		}
		if (probes.length === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no declared operator has a value of its field's type to probe with",
			)
		}
		/* Every operator at once; the answers are judged in declaration order. */
		const results = await Promise.all(
			probes.map(async ({ label, term }) => ({ label, result: await list(ctx, { ...q(ctx, { limit: 5 }), ...term }) })),
		)
		for (const { label, result } of results) {
			const answer = declarationAnswer(result.exchange.status)
			if (answer === "refused") {
				refusedBy.push(result.exchange)
				rejected.push(`${label} (${result.exchange.status})`)
			}
			if (answer === "unknown") unknown.push(`${label} (${result.exchange.status})`)
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
			"the document declares a filter operator the backend rejects",
			`declared ops that 4xx: ${rejected.slice(0, 8).join(", ")}.`,
			refusedBy.slice(0, 3),
		)
	},
})
