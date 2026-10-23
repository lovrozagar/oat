import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { Exchange } from "../../../exchange.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import type { CheckContext } from "../../core/context.ts"
import { ready } from "../../core/plan.ts"
import { graded, ownOps } from "../../planning/subjects.ts"

/* The media type RFC 9457 registers for a problem detail, with or without parameters. */
const PROBLEM_JSON = /^application\/problem\+json\s*(;|$)/i

/* A base any relative reference resolves against: only whether the reference parses matters. */
const BASE = "https://problem.invalid/"

/* The members RFC 9457 §3.1 defines as plain strings. */
const STRING_MEMBERS = ["title", "detail", "instance"] as const

/**
 * Every answer served as `application/problem+json` must be shaped as RFC 9457 defines it.
 *
 * Clients read a problem detail by its registered members, not by the operation's own document: a
 * `status` that names another status than the response's, or a member of the wrong type, misleads
 * every one of them alike. Any answer of this entity's that oat drew is judged, a probe's too: a
 * refusal is right to be one, and still wrong to describe itself falsely.
 */
export const problemJsonShape: Check = defineCheck({
	plan: () => ready(undefined),
	id: "schema.problem-json-shape",
	judgesTranscript: true,
	subjects: (entity, model) => ownOps(entity, model, () => true),
	async run(ctx): Promise<Outcome> {
		const judged = new Set<string>()
		const flawed = new Set<string>()
		const lines: string[] = []
		const evidence: Exchange[] = []
		for (const listed of ctx.client.exchangesForEntity(ctx.entityName)) {
			const operationId = judgedOperation(ctx, listed)
			if (operationId === undefined) continue
			judged.add(operationId)
			const exchange = await ctx.client.hydrate(listed)
			const flaws = problemFlaws(exchange.responseBody, exchange.status)
			if (flaws.length === 0) continue
			flawed.add(operationId)
			lines.push(`${operationId} answered ${exchange.status} with ${flaws.join(", ")}`)
			if (evidence.length < 6) evidence.push(exchange)
		}
		ctx.judged?.([...judged])
		if (lines.length === 0) return ASSERTED
		return ctx.findings.attributed([...flawed]).backend(this.id, ctx.entityName, {
			summary: "a problem detail is not shaped as RFC 9457 defines it",
			detail:
				`${lines.join(". ")}. A client reads a problem detail by the members RFC 9457 defines, so a ` +
				"member of the wrong type, or a status other than the response's, misleads it about the failure.",
			evidence,
		})
	},
})

/** The operation a problem-detail answer judges: one of this entity's, graded by this run. */
function judgedOperation(ctx: CheckContext, exchange: Exchange): string | undefined {
	if (!PROBLEM_JSON.test(exchange.responseHeaders["content-type"] ?? "")) return undefined
	const op = exchange.operationId === undefined ? undefined : ctx.model.byOperationId.get(exchange.operationId)
	if (op === undefined || op.entity !== ctx.entityName || !graded(ctx, op)) return undefined
	return op.operationId
}

/** How a problem detail departs from RFC 9457 §3.1, member by member; empty when it does not. */
function problemFlaws(body: unknown, status: number): string[] {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return ["a body that is not a JSON object"]
	const problem = body as Record<string, unknown>
	const flaws: string[] = []
	if ("type" in problem && !isUriReference(problem["type"]))
		flaws.push(`"type" ${shown(problem["type"])}, not a URI reference`)
	for (const member of STRING_MEMBERS) {
		if (member in problem && typeof problem[member] !== "string") {
			flaws.push(`"${member}" ${shown(problem[member])}, not a string`)
		}
	}
	if ("status" in problem && problem["status"] !== status) {
		flaws.push(`"status" ${shown(problem["status"])}, not the HTTP status ${status}`)
	}
	return flaws
}

/* A URI reference (RFC 3986 §4.1): a string with no character a URI never holds that parses as one. */
function isUriReference(value: unknown): boolean {
	return typeof value === "string" && !/[\s"<>\\^`{|}]/.test(value) && URL.canParse(value, BASE)
}

/* A member's value as JSON, cut short. */
function shown(value: unknown): string {
	return JSON.stringify(value).slice(0, 60)
}
