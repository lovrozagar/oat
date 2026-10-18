/**
 * What must hold after a destructive call the backend accepted: the suite caller still reads
 * itself, a deleted record is no longer listed, and a session the call ended is refused and no
 * longer renews.
 */

import type { OperationModel } from "../../spec/graph/types.ts"
import type { Exchange } from "../exchange.ts"
import type { FindingCollector } from "../finding.ts"
import { fillPath } from "../fill-path.ts"
import type { PassEvidence } from "../grades.ts"
import { DISPOSABLE_CHECK_ID } from "./check.ts"
import { identityOf, parentList, recordsOf } from "./lists.ts"
import type { DisposableInput, Session } from "./types.ts"

/** Where a failure lands: the operation's collector, under its entity. */
export interface Blame {
	collector: FindingCollector
	entity: string
}

/** An accepted destructive call and what it ran with. */
export interface Accepted {
	op: OperationModel
	session: Session
	read: OperationModel
	ends: boolean
	blame: Blame
	called: Exchange
	values: Record<string, string>
}

type Observation = PassEvidence["observation"]

/* A failure was reported: nothing is proved. */
const BLAMED = "blamed"

export async function afterCall(input: DisposableInput, call: Accepted): Promise<void> {
	const { op, read, blame, called } = call
	const caller = await input.client.request(read.method, read.path, {
		headers: input.auth,
		operationId: read.operationId,
	})
	if (caller.status !== 200) {
		blame.collector.backend(
			DISPOSABLE_CHECK_ID,
			read.entity ?? "caller",
			"the suite caller was logged out",
			`${op.operationId} ran as the second user, and the suite ${read.operationId} then returned ${caller.status}.`,
			[called, caller],
		)
		return
	}
	let observation = await listedGone(input, call)
	if (observation === BLAMED) return
	if (call.ends) {
		observation = await sessionEnded(input, call)
		if (observation === BLAMED) return
	}
	input.grades.prove(
		op.operationId,
		observation === undefined ? { call: called.seq } : { call: called.seq, observation },
	)
}

/** A deleted record read back from the list one level up: absent proves it, present fails it. */
async function listedGone(input: DisposableInput, call: Accepted): Promise<Observation | typeof BLAMED> {
	const { op, session, values, blame, called } = call
	const param = op.pathParams.at(-1)
	const list = parentList(input.model, op)
	if (op.method.toUpperCase() !== "DELETE" || param === undefined || list === undefined) return undefined
	const listed = await input.client.request(list.method, fillPath(list.path, values), {
		headers: session.headers,
		operationId: list.operationId,
	})
	const field = identityOf(list, input.model, param)
	/* `runOne` filled every path parameter before the call. */
	const value = values[param] as string
	if (listed.status < 200 || listed.status >= 300) return undefined
	if (recordsOf(listed.responseBody, list, input.model).some((row) => row[field] === value)) {
		blame.collector.backend(
			DISPOSABLE_CHECK_ID,
			blame.entity,
			"the credential was still listed",
			`${op.operationId} returned ${called.status}, and the follow-up list still contained ${value}.`,
			[called, listed],
		)
		return BLAMED
	}
	return { absent: true, path: "$", seq: listed.seq, value }
}

/** The ended session read again, and its refresh tried: both must be refused. */
async function sessionEnded(input: DisposableInput, call: Accepted): Promise<Observation | typeof BLAMED> {
	const { op, session, read, blame, called } = call
	const gone = await input.client.request(read.method, read.path, {
		headers: session.headers,
		operationId: read.operationId,
	})
	const renewed = session.renew === undefined ? undefined : await session.renew()
	const refused = gone.status === 401 || gone.status === 403 || gone.status === 404
	/* A declared refresh that answered anything but a 4xx still renews. */
	const renews = renewed !== undefined && !(renewed.status >= 400 && renewed.status < 500)
	if (!refused && renews) {
		blame.collector.backend(
			DISPOSABLE_CHECK_ID,
			blame.entity,
			"the disposable session was still accepted",
			`${op.operationId} invalidates ${read.operationId}, and that read then returned ${gone.status} with the second user's credential.`,
			[called, gone, renewed],
		)
		return BLAMED
	}
	if (refused && renews) {
		blame.collector.backend(
			DISPOSABLE_CHECK_ID,
			blame.entity,
			"the refresh token still renews after the session ended",
			`${op.operationId} ended the session, and the declared refresh then returned ${renewed.status}.`,
			[called, gone, renewed],
		)
		return BLAMED
	}
	return refused
		? { seq: gone.seq, status: gone.status }
		: { seq: (renewed as Exchange).seq, status: (renewed as Exchange).status }
}
