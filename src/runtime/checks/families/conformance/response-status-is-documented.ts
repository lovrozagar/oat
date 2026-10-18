import { defineCheck } from "../../core/define.ts"
import { documentsStatus, type OperationModel, readStatuses } from "../../../../spec/graph.ts"
import type { OperationObject } from "../../../../spec/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { isDocumentedFeatureGateDenial } from "../../../feature-gate.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import type { CheckContext } from "../../core/context.ts"
import { when } from "../../core/plan.ts"
import { graded, subjectsOf } from "../../planning/subjects.ts"

/** One line per operation: what it returned, and what the document declares. */
export function describeUndeclared(
	ctx: CheckContext,
	byOp: Map<string, Exchange[]>,
): { lines: string[]; evidence: Exchange[] } {
	const lines: string[] = []
	const evidence: Exchange[] = []
	for (const [operationId, exchanges] of byOp) {
		const raw = ctx.model.rawOperations.get(operationId)
		const declaredStatuses = Object.keys(raw?.responses ?? {})
			.filter((key) => key !== "default")
			.sort()
			.join(", ")
		const seen = [...new Set(exchanges.map((item) => item.status))].sort((a, b) => a - b)
		lines.push(
			`${operationId} returned ${seen.join(", ")}; the document declares ${declaredStatuses || "no concrete status"}`,
		)
		const first = exchanges[0]
		if (first !== undefined && evidence.length < 6) evidence.push(first)
	}
	return { evidence, lines }
}

function statusIsDeclared(raw: OperationObject | undefined, status: number): boolean {
	return documentsStatus(readStatuses(raw?.responses), status)
}

function declaresConcreteStatuses(raw: OperationObject | undefined): boolean {
	const statuses = readStatuses(raw?.responses)
	return statuses.exact.length > 0 || statuses.ranges.length > 0
}

/** The operation an exchange judges: this entity's, graded by this run, and not its create. */
function judgedOperation(ctx: CheckContext, exchange: Exchange): OperationModel | undefined {
	const op = exchange.operationId === undefined ? undefined : ctx.model.byOperationId.get(exchange.operationId)
	if (op === undefined || op.entity !== ctx.entityName) return undefined
	if (!graded(ctx, op)) return undefined
	if (op.operationId === ctx.createOp?.operationId || op.action === "create") return undefined
	return op
}

/**
 * What one exchange says about its operation's statuses: `null` when it says nothing, else the
 * operation it observed and, when the status is one the document leaves out, how it was sent.
 */
async function readExchange(
	ctx: CheckContext,
	listed: Exchange,
): Promise<{ operationId: string; exchange: Exchange; undeclared: "probe" | "ordinary" | null } | null> {
	/* A documented feature-gate denial is told apart by its body. */
	const exchange = listed.status === 403 ? await ctx.client.hydrate(listed) : listed
	/* A status-0 network failure has no status to judge, and an answer that was asked again
	 * after a refresh or a wait is not the backend's verdict on the request. */
	if (exchange.status === 0 || exchange.superseded === true) return null
	const op = judgedOperation(ctx, exchange)
	if (op === undefined || exchange.status === 429) return null
	const raw = ctx.model.rawOperations.get(op.operationId)
	if (!declaresConcreteStatuses(raw)) return null
	const operationId = op.operationId
	if (isDocumentedFeatureGateDenial(op, exchange.status, exchange.responseBody)) {
		return { exchange, operationId, undeclared: null }
	}
	if (statusIsDeclared(raw, exchange.status)) return { exchange, operationId, undeclared: null }
	/* A deliberately invalid request may draw a status the document never needed to name
	 * for real traffic. It is reported, but apart from what ordinary requests got. */
	return { exchange, operationId, undeclared: exchange.purpose === "probe" ? "probe" : "ordinary" }
}

export const documentedStatusHonoured = defineCheck({
	plan: (ctx) => when(ctx.model.operations.some((op) => op.entity === ctx.entityName && op.action !== "create")),
	id: "response.status-is-documented",
	judgesTranscript: true,
	needs: "a modeled non-create operation on this entity",
	subjects: subjectsOf.nonCreate,
	async run(ctx): Promise<Outcome> {
		const byOp = new Map<string, Exchange[]>()
		const probes = new Map<string, Exchange[]>()
		const observed = new Set<string>()
		for (const listed of ctx.client.exchangesForEntity(ctx.entityName)) {
			const reading = await readExchange(ctx, listed)
			if (reading === null) continue
			observed.add(reading.operationId)
			if (reading.undeclared === null) continue
			const bucket = reading.undeclared === "probe" ? probes : byOp
			const seen = bucket.get(reading.operationId) ?? []
			seen.push(reading.exchange)
			bucket.set(reading.operationId, seen)
		}
		ctx.judged?.([...observed])
		if (probes.size > 0) {
			const { lines, evidence } = describeUndeclared(ctx, probes)
			ctx.findings
				.attributed([...probes.keys()])
				.spec(
					this.id,
					ctx.entityName,
					"requests oat sent to be refused drew statuses the document does not declare",
					`${lines.join(". ")}. These were deliberately invalid probes, so the refusal is right; ` +
						"its status is what the document leaves out.",
					evidence,
				)
		}
		/* Every operation in the map has a line, so an empty map is the only clean answer. */
		if (byOp.size === 0) return ASSERTED

		const { lines, evidence } = describeUndeclared(ctx, byOp)
		return ctx.findings
			.attributed([...byOp.keys()])
			.spec(
				this.id,
				ctx.entityName,
				"an operation returned a status the document does not declare",
				`${lines.join(". ")}. Clients generated from this document will not recognise the response.`,
				evidence,
			)
	},
})
