/** How the check reaches the caller's routes, and what a throttled answer means for it. */

import type { Client } from "../../client/client.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { Exchange } from "../exchange.ts"
import { fillPath } from "../fill-path.ts"
import type { FindingCollector, Outcome } from "../finding.ts"
import { SELF_CHECK_ID } from "./operations.ts"

export function operation(model: SpecModel, id: string | undefined): OperationModel | undefined {
	return id === undefined ? undefined : model.byOperationId.get(id)
}

/** The route with no path id to fill, or `null` when it needs one: the caller's routes name no record. */
export function pathOf(op: OperationModel): string | null {
	try {
		return fillPath(op.path, {})
	} catch {
		return null
	}
}

/** The caller as the check acts as it: its client and its credential. */
export interface Caller {
	client: Client
	auth: () => Record<string, string>
}

export async function sendUpdate(
	caller: Caller,
	op: OperationModel,
	path: string,
	body: Record<string, unknown>,
): Promise<Exchange> {
	return caller.client.request(op.method, path, {
		body,
		headers: caller.auth,
		operationId: op.operationId,
	})
}

/** A 429 that outlived the client's retries is the bucket, not the caller routes: nothing was shown. */
export function throttled(findings: FindingCollector, entity: string): Outcome {
	return findings.unresolved(
		SELF_CHECK_ID,
		entity,
		"the request was rate-limited (429) after retries, so this check could not complete",
	)
}
