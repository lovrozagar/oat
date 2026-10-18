import { defineCheck } from "../../core/define.ts"
import { canWriteFilterOp, filterSpec, filterTerm } from "../../../../spec/conventions/filter.ts"
import { renderUnknownOp } from "../../../../spec/render/filter-probe.ts"
import type { EffectiveFilterField } from "../../../../spec/query/effective.ts"
import { opsAreClosed, opsForField } from "../../../../spec/query/field-ops.ts"
import { FILTER_OPS } from "../../../../spec/query/ops.ts"
import type { Outcome } from "../../../finding.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { judgeRefusal } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { asTermValue, conv, pageSize, q, resolvedCaps } from "../../query/capabilities.ts"
import { ids, list } from "../../sets/list.ts"

function firstIllegalOp(ctx: CheckContext, field: EffectiveFilterField): (typeof FILTER_OPS)[number] | undefined {
	const caps = resolvedCaps(ctx)
	if (!opsAreClosed(field, caps)) return undefined
	const allowed = new Set(opsForField(field, caps))
	/* An alias spells an allowed operator another way (`ne` for `neq`): it is not illegal. */
	const permitted = (op: (typeof FILTER_OPS)[number]): boolean => {
		const target = caps.aliases[op]
		return allowed.has(op) || (target !== undefined && allowed.has(target))
	}
	return FILTER_OPS.find((op) => !permitted(op) && canWriteFilterOp(conv(ctx), op))
}

type IllegalOpProbe = {
	field: EffectiveFilterField
	/** The operator as written: one outside the field's closed list, or a token the grammar lacks. */
	op: string
	/** Whether the operator exists but the field's closed list leaves it out, or does not exist at all. */
	kind: "closed" | "unknown"
	term: Record<string, string>
	/** The same field under an operator it allows: the control that the field itself is accepted. */
	control: Record<string, string>
}

export const filterIllegalOpRejected = defineCheck<{ probes: IllegalOpProbe[] }>({
	plan: (ctx) => {
		const probes: IllegalOpProbe[] = []
		for (const field of resolvedCaps(ctx).filterable) {
			const op = firstIllegalOp(ctx, field)
			if (op === undefined) continue
			const sample = ctx.records.find((row) => row[field.field] != null)
			const value = sample === undefined ? "oat-probe" : asTermValue(sample[field.field])
			const legal = opsForField(field, resolvedCaps(ctx)).find((allowed) => canWriteFilterOp(conv(ctx), allowed))
			const term = filterTerm(conv(ctx), { field: field.field, op, value })
			const control =
				legal === undefined
					? null
					: filterTerm(conv(ctx), { field: field.field, op: legal as (typeof FILTER_OPS)[number], value })
			if (term !== null && control !== null) probes.push({ control, field, kind: "closed", op, term })
		}
		/* An operator token the grammar does not have at all — asked only of a declared grammar, where
		 * the token is unknown on purpose rather than because oat guessed the spelling. */
		const conventions = conv(ctx)
		if (conventions.grammarDeclared === true) {
			for (const field of resolvedCaps(ctx).filterable) {
				const sample = ctx.records.find((row) => row[field.field] != null)
				const value = sample === undefined ? "oat-probe" : String(asTermValue(sample[field.field]))
				const term = renderUnknownOp(
					{ field: field.field, filterParam: conventions.filter, spec: filterSpec(conventions), value },
					UNKNOWN_OP,
				)
				const control = filterTerm(conventions, { field: field.field, op: "eq", value })
				if (term === null || control === null) continue
				probes.push({ control, field, kind: "unknown", op: UNKNOWN_OP, term })
				break
			}
		}
		return probes.length === 0 ? cannot() : ready({ probes })
	},
	dependsOn: ["list.read-after-write", "filter.unknown-field-rejected", "error.malformed-filter-not-5xx"],
	id: "filter.illegal-op-rejected",
	needs: "a field with a closed operator list, or a declared filter grammar",
	subjects: subjectsOf.list,
	async run(ctx, { probes }): Promise<Outcome> {
		/* A refusal proves the operator is policed only when the field itself is accepted: a field
		 * the backend will not filter on at all refuses every operator, illegal or not. */
		let picked: IllegalOpProbe | undefined
		for (const probe of probes) {
			const control = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...probe.control })
			if (control.exchange.status < 400) {
				picked = probe
				break
			}
		}
		if (picked === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no field with a closed operator list accepted even an operator it allows",
			)
		}
		const { field, kind, op, term } = picked
		const baseline = await list(ctx, q(ctx, { limit: pageSize(ctx) }))
		const result = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...term })
		if (result.exchange.status >= 500) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "an illegal filter operator produces a server error",
				detail: `${field.field}.${op} returned ${result.exchange.status}; a rejected operator should be 4xx.`,
				evidence: [result.exchange],
			})
		}
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused
		const same = ids(result.items, ctx.identity).join(",") === ids(baseline.items, ctx.identity).join(",")
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "an illegal filter operator is accepted",
			detail:
				`${field.field}.${op} returned ${result.exchange.status}` +
				(same ? " with the unfiltered set, so the operator was ignored" : "") +
				(kind === "closed"
					? ". A closed operator list is a contract: anything outside it must be rejected."
					: ". The declared grammar has no such operator, so the term must be rejected, not dropped."),
			evidence: [baseline.exchange, result.exchange],
		})
	},
})

/** An operator token no filter grammar has. */
const UNKNOWN_OP = "zz"
