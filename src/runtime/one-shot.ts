/**
 * A public read with no id and no entity. Nothing has to be created first.
 * The document names a success status, and that is what an empty request must get.
 * A generated body is not sent: a 400 on a body the check invented would not be the server.
 */

import type { Check } from "./checks.ts"
import type { Client } from "./client.ts"
import { ASSERTED, type FindingCollector, type Outcome } from "./finding.ts"
import type { CheckId } from "./check-ids.ts"
import { describeSuccess, type OperationModel, type SpecModel } from "../spec/graph.ts"
import type { GradeLedger } from "./scope.ts"
import { fillPath } from "./world.ts"

export const PUBLIC_GET_CHECK_ID = "response.public-get-returns-success" as const satisfies CheckId

/** A read anyone can make, with nothing to fill in. */
export function isPublicGet(op: OperationModel): boolean {
	const method = op.method.toUpperCase()
	if (op.entity !== null) return false
	if (method !== "GET" && method !== "HEAD") return false
	if (op.pathParams.length > 0 || op.path.includes("{")) return false
	if (op.queryParamNames.length > 0) return false
	if (op.hasRequestBody || op.isMutation) return false
	if (op.securitySchemes.length > 0) return false
	return true
}

/** The document names a 2xx, exactly or as a `2XX` range. */
export function documentsSuccess(op: OperationModel): boolean {
	return op.statuses.exact.some((code) => code >= 200 && code < 300) || op.statuses.ranges.includes(2)
}

function successMatches(op: OperationModel, status: number): boolean {
	if (status < 200 || status >= 300) return false
	if (op.statuses.ranges.includes(2)) return true
	return op.statuses.exact.includes(status)
}

export async function runPublicGets(input: {
	checksRun: Set<string>
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	model: SpecModel
}): Promise<void> {
	const ops = input.model.operations.filter(
		(op) => isPublicGet(op) && documentsSuccess(op) && (input.mode === "full" || input.inScope(op.operationId)),
	)
	if (ops.length === 0) return
	input.checksRun.add(PUBLIC_GET_CHECK_ID)
	for (const op of ops) {
		let path: string
		try {
			path = fillPath(op.path, {})
		} catch {
			input.grades.skipped([op.operationId], "the path needs an id")
			continue
		}
		const exchange = await input.client.request(op.method, path, {
			headers: {},
			operationId: op.operationId,
			skipAuthRefresh: true,
		})
		input.grades.graded([op.operationId], PUBLIC_GET_CHECK_ID)
		if (successMatches(op, exchange.status)) continue
		const expected = describeSuccess(op.statuses).join(", ") || "2xx"
		input.findings
			.attributed([op.operationId])
			.ownedBy(PUBLIC_GET_CHECK_ID)
			.backend(
				PUBLIC_GET_CHECK_ID,
				op.operationId,
				"a public read did not return its success status",
				`${op.operationId} returned ${exchange.status}. The document says ${expected} for a request with no token and no id.`,
				[exchange],
			)
	}
}

export const publicGetCheck: Check = {
	id: PUBLIC_GET_CHECK_ID,
	needs: "a public GET or HEAD with no id, no query, and a documented success status",
	plan: () => ({ ok: false }),
	run: (): Promise<Outcome> => Promise.resolve(ASSERTED),
	/* The routes have no entity, so the entity loop cannot grade them. `runPublicGets` does. */
	subjects: () => [],
}
