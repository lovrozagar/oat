/**
 * A write whose body is signed outside the document. The hook returns the exact bytes and
 * headers. The call passes when an invalidated read changes and contains a string from that body.
 */

import type { Hooks } from "../config/define-config.ts"
import type { Client, Exchange } from "./client.ts"
import type { FindingCollector } from "./finding.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"
import type { GradeLedger } from "./scope.ts"
import { parseRouteRef } from "../spec/load.ts"
import { fillPath } from "./world.ts"

export const SIGNED_EVENT_CHECK_ID = "signed.event-changes-the-read"

export async function runSignedEvents(input: {
	auth: () => Record<string, string>
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	hooks?: Hooks
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	model: SpecModel
	roots?: Record<string, string>
}): Promise<void> {
	if (input.hooks?.resolveSignedEvent === undefined) return
	const ops = input.model.operations.filter(
		(op) => hasSignedEvent(input.model, op) && (input.mode === "full" || input.inScope(op.operationId)),
	)
	const scope = input.roots ?? {}
	for (const op of ops) {
		const ids = [op.operationId]
		const blame = input.findings.attributed(ids).ownedBy(SIGNED_EVENT_CHECK_ID)
		const read = invalidatedGet(input.model, op)
		const signed = await input.hooks.resolveSignedEvent({ operationId: op.operationId, scope })
		if (signed === null || read === undefined) {
			blame.backend(
				SIGNED_EVENT_CHECK_ID,
				op.entity ?? "caller",
				"the signed event was not prepared",
				`${op.operationId} had no signed body or no follow-up read.`,
				[],
			)
			input.grades.graded(ids, SIGNED_EVENT_CHECK_ID)
			continue
		}
		let readPath = read.path
		try {
			readPath = fillPath(read.path, scope)
		} catch {
			blame.backend(
				SIGNED_EVENT_CHECK_ID,
				read.entity ?? "caller",
				"the follow-up read had no scope",
				`${read.operationId} could not fill ${read.path}.`,
				[],
			)
			input.grades.graded(ids, SIGNED_EVENT_CHECK_ID)
			continue
		}
		const before = await input.client.request(read.method, readPath, {
			headers: input.auth,
			operationId: read.operationId,
		})
		const called = await input.client.request(op.method, op.path, {
			body: signed.body,
			contentType: "application/json",
			headers: signed.headers,
			operationId: op.operationId,
		})
		const after = await input.client.request(read.method, readPath, {
			headers: input.auth,
			operationId: read.operationId,
		})
		if (called.status < 200 || called.status >= 300 || !readShows(signed.body, before, after)) {
			blame.backend(
				SIGNED_EVENT_CHECK_ID,
				read.entity ?? "caller",
				"the follow-up read did not show this event",
				`${op.operationId} returned ${called.status}, and ${read.operationId} did not gain a value from this body.`,
				[before, called, after],
			)
		}
		input.grades.graded(ids, SIGNED_EVENT_CHECK_ID)
	}
}

function hasSignedEvent(model: SpecModel, op: OperationModel): boolean {
	const raw = model.rawOperations.get(op.operationId) as { "x-signed-event"?: unknown } | undefined
	return raw?.["x-signed-event"] === true
}

function invalidatedGet(model: SpecModel, op: OperationModel): OperationModel | undefined {
	for (const named of op.invalidates) {
		const parsed = parseRouteRef(named)
		if (parsed === null || parsed.method !== "GET") continue
		const found = model.operations.find((item) => item.method === "GET" && item.path === parsed.path)
		if (found !== undefined) return found
	}
	return undefined
}

function readShows(body: string, before: Exchange, after: Exchange): boolean {
	if (before.status < 200 || before.status >= 300 || after.status < 200 || after.status >= 300) return false
	const beforeText = JSON.stringify(before.responseBody)
	const afterText = JSON.stringify(after.responseBody)
	if (beforeText === afterText) return false
	return claimedStrings(body).some((value) => afterText.includes(value) && !beforeText.includes(value))
}

function claimedStrings(body: string): string[] {
	let parsed: unknown
	try {
		parsed = JSON.parse(body) as unknown
	} catch {
		return []
	}
	const out: string[] = []
	const walk = (value: unknown) => {
		if (typeof value === "string") {
			if (value.length >= 12) out.push(value)
			return
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item)
			return
		}
		if (value !== null && typeof value === "object") {
			for (const child of Object.values(value as Record<string, unknown>)) walk(child)
		}
	}
	walk(parsed)
	return out
}
