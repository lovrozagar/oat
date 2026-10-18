/**
 * The floor under every operation: nothing in the document goes uncalled. An operation no check
 * and no scenario graded is called once with a request built from its own schema. A documented
 * success whose body matches the schema passes at the `contract` tier — the weakest honest
 * claim, and the report says so. A server error or a body that breaks the schema fails. A
 * refused request leaves it untested with the refusal as the reason, because a request oat
 * guessed is not proof the backend is wrong; that operation needs a scenario.
 */

import type { Hooks } from "../config/types/hooks.ts"
import type { OperationObject } from "../spec/types.ts"
import { documentsStatus, type OperationModel, type SpecModel } from "../spec/graph.ts"
import { requestContent } from "../spec/collection.ts"
import type { CheckId } from "./check-ids.ts"
import type { Client } from "../client/client.ts"
import type { Exchange } from "./exchange.ts"
import { buildCohort } from "./fixture.ts"
import type { Check } from "./checks/core/check.ts"
import { ASSERTED, type FindingCollector, type Outcome } from "./finding.ts"
import { applyActionBind, readActionBind } from "./effects.ts"
import { describeServerError, headerValue } from "./rate-limit.ts"
import type { GradeLedger } from "./grades.ts"
import type { SchemaValidator } from "./validate.ts"
import { requestSchemaOf } from "./world.ts"
import { fillPath } from "./fill-path.ts"

export const CONTRACT_CHECK_ID = "response.contract-call" as const satisfies CheckId

export const contractCallCheck: Check = {
	id: CONTRACT_CHECK_ID,
	needs: "an operation nothing else graded, with every path parameter resolvable",
	plan: () => ({ ok: false }),
	run: (): Promise<Outcome> => Promise.resolve(ASSERTED),
	/* Runs after every check and scenario, over what they left ungraded. `runContractCalls` does. */
	subjects: () => [],
}

interface Parameter {
	in?: string
	name?: string
	required?: boolean
	schema?: { enum?: unknown[]; default?: unknown; type?: string }
}

function parametersOf(raw: OperationObject | undefined): Parameter[] {
	const params = (raw as { parameters?: unknown } | undefined)?.parameters
	return Array.isArray(params) ? (params as Parameter[]) : []
}

function exampleOf(schema: Parameter["schema"]): string | undefined {
	if (schema?.enum !== undefined && schema.enum.length > 0) return String(schema.enum[0])
	if (schema?.default !== undefined) return String(schema.default)
	if (schema?.type === "integer" || schema?.type === "number") return "1"
	if (schema?.type === "boolean") return "true"
	if (schema?.type === "string") return "oat"
	return undefined
}

/** A value an earlier success already returned under exactly this name — the newest one. */
function seenValue(transcript: readonly Exchange[], name: string): string | undefined {
	const find = (node: unknown, depth: number): string | undefined => {
		if (depth > 5 || node === null || typeof node !== "object") return undefined
		if (Array.isArray(node)) {
			for (const item of node) {
				const hit = find(item, depth + 1)
				if (hit !== undefined) return hit
			}
			return undefined
		}
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (key === name && (typeof value === "string" || typeof value === "number") && String(value) !== "") {
				return String(value)
			}
			const hit = find(value, depth + 1)
			if (hit !== undefined) return hit
		}
		return undefined
	}
	for (let index = transcript.length - 1; index >= 0; index--) {
		const exchange = transcript[index]
		if (exchange === undefined || exchange.status < 200 || exchange.status >= 300) continue
		const hit = find(exchange.responseBody, 0)
		if (hit !== undefined) return hit
	}
	return undefined
}

function snippet(body: unknown): string {
	const text = typeof body === "string" ? body : JSON.stringify(body)
	return text === undefined ? "" : text.slice(0, 160)
}

export async function runContractCalls(input: {
	model: SpecModel
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	checksRun: Set<string>
	validator: SchemaValidator
	auth: () => Record<string, string>
	roots: Record<string, string>
	hooks: Hooks
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	seed: number
	nonce: string
	/** Operations a scenario owns. Its verdict stands, even when it stopped before them. */
	owned: ReadonlySet<string>
	/** True once the run was interrupted or the network is gone: send nothing more. */
	stopped: () => boolean
}): Promise<void> {
	const { model, grades } = input
	const pending = model.operations.filter(
		(op) =>
			!op.destructive &&
			!input.owned.has(op.operationId) &&
			(input.mode === "full" || input.inScope(op.operationId)) &&
			(grades.ran.get(op.operationId)?.size ?? 0) === 0 &&
			!grades.evidence.has(op.operationId),
	)
	if (pending.length === 0) return
	input.checksRun.add(CONTRACT_CHECK_ID)
	for (const op of pending) {
		if (input.stopped()) return
		try {
			await callOnce(op)
		} catch (error) {
			/* A refused credential or a dropped connection is not this operation's verdict. */
			grades.skipped(
				[op.operationId],
				`contract call could not be sent: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	async function callOnce(op: OperationModel): Promise<void> {
		const raw = model.rawOperations.get(op.operationId)
		/* Already called on the way to something else — signup, a scenario's support step. Grade
		 * that exchange; calling again would only repeat a side effect. */
		const earlier = input.client.transcript.findLast(
			(exchange) => exchange.operationId === op.operationId && exchange.status >= 200 && exchange.status < 300,
		)
		if (earlier !== undefined) {
			/* The transcript may have moved the body to disk; judge the body the server sent. */
			judge(op, raw, await input.client.hydrate(earlier))
			return
		}
		const params = parametersOf(raw)
		const headers = input.auth()
		const values: Record<string, string> = {}
		for (const name of op.pathParams) {
			const declared = params.find((param) => param.in === "path" && param.name === name)
			const value =
				input.roots[name] ??
				(declared?.schema?.enum === undefined ? undefined : exampleOf(declared.schema)) ??
				(await input.hooks.resolvePathValue?.({
					enumValues: (declared?.schema?.enum ?? []).map(String),
					headers,
					method: op.method,
					operationId: op.operationId,
					param: name,
					path: op.path,
				})) ??
				seenValue(input.client.transcript, name)
			if (value === undefined || value === null) {
				grades.skipped([op.operationId], `unresolved param ${name}`)
				return
			}
			values[name] = value
		}
		/* What the operation names in `x-bind` is a value it accepts; a literal there beats a guess.
		 * A pointer reads a record this call has none of, so it binds nothing here. */
		const bind = readActionBind((raw as Record<string, unknown> | undefined)?.["x-bind"])
		const bound = applyActionBind(bind, [], undefined, undefined).query
		const query: Record<string, string> = {}
		for (const param of params) {
			if (param.in !== "query" || param.required !== true || param.name === undefined) continue
			const value = bound[param.name] ?? op.requiredQuery[param.name] ?? exampleOf(param.schema)
			if (value === undefined) {
				grades.skipped([op.operationId], `unresolved query param ${param.name}`)
				return
			}
			query[param.name] = value
		}
		let body: unknown
		const content = raw === undefined ? null : requestContent(raw)
		if (content !== null) {
			if (!content.mediaType.includes("json")) {
				grades.skipped([op.operationId], `needs a ${content.mediaType} body oat cannot build without a scenario`)
				return
			}
			const [member] = buildCohort(requestSchemaOf(op, model) ?? {}, input.seed, ["baseline"], op.operationId, {
				defs: model.defs,
				/* By operation, not by how many requests came before: the same run sends the same body. */
				nonce: `${input.nonce}c${op.operationId}`,
			})
			const built = member?.body ?? {}
			body =
				built !== null && typeof built === "object" && !Array.isArray(built)
					? applyActionBind(bind, [], undefined, built as Record<string, unknown>).body
					: built
		}
		const exchange = await input.client.request(op.method, fillPath(op.path, values), {
			...(body === undefined ? {} : { body }),
			headers,
			operationId: op.operationId,
			...(Object.keys(query).length === 0 ? {} : { query }),
		})
		judge(op, raw, exchange)
	}

	function judge(op: OperationModel, raw: OperationObject | undefined, exchange: Exchange): void {
		const blame = input.findings.attributed([op.operationId]).ownedBy(CONTRACT_CHECK_ID)
		const entity = op.entity ?? op.operationId
		if (exchange.status >= 500) {
			grades.graded([op.operationId], CONTRACT_CHECK_ID)
			blame.backend(
				CONTRACT_CHECK_ID,
				entity,
				`a schema-built request ${describeServerError(exchange.status, headerValue(exchange.responseHeaders, "retry-after"))}`,
				`${op.operationId} returned ${exchange.status}: ${snippet(exchange.responseBody)}`,
				[exchange],
			)
			return
		}
		if (exchange.status >= 400) {
			grades.skipped(
				[op.operationId],
				`contract call returned ${exchange.status} (${snippet(exchange.responseBody)}); a scenario must set the scene`,
			)
			return
		}
		if (!documentsStatus(op.statuses, exchange.status)) {
			/* `response.status-is-documented` owns that defect; an undocumented success proves nothing here. */
			grades.skipped([op.operationId], `contract call returned ${exchange.status}, which the document does not name`)
			return
		}
		grades.graded([op.operationId], CONTRACT_CHECK_ID)
		/* A documented status with no body schema has nothing more to hold the body to. */
		const result =
			raw !== undefined && input.validator.documents(raw, exchange.status)
				? input.validator.validate(op.operationId, raw, exchange.status, exchange.responseBody)
				: { ok: true, errors: [] as string[], unchecked: undefined }
		if (result.unchecked === undefined && !result.ok) {
			blame.spec(
				CONTRACT_CHECK_ID,
				entity,
				"success response does not match its documented schema",
				`${op.operationId} returned ${exchange.status} with a body that fails the declared schema: ${result.errors.join("; ")}`,
				[exchange],
			)
			return
		}
		grades.prove(op.operationId, { call: exchange.seq })
	}
}

const DELETE_CHECK_ID = "delete.absent-record-returns-404" as const satisfies CheckId

/**
 * A delete that only answered 2xx has not been shown to delete anything. Read the same resource
 * once: 404 or 410 proves it, as does a soft-delete marker set on what comes back. A record that
 * is still readable, unmarked, was not deleted.
 */
export async function confirmDeletes(input: {
	model: SpecModel
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	auth: () => Record<string, string>
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	stopped: () => boolean
}): Promise<void> {
	const { grades, model } = input
	for (const op of model.operations) {
		if (input.stopped()) return
		if (op.method.toUpperCase() !== "DELETE") continue
		if (input.mode === "targeted" && !input.inScope(op.operationId)) continue
		if (grades.evidence.get(op.operationId)?.observation !== undefined) continue
		const read = model.operations.find((other) => other.method.toUpperCase() === "GET" && other.path === op.path)
		if (read === undefined) continue
		const call = input.client.transcript.findLast(
			(exchange) => exchange.operationId === op.operationId && exchange.status >= 200 && exchange.status < 300,
		)
		if (call === undefined) continue
		let path: string
		try {
			/* Below the base URL, as the client takes it: under a mount like `/api` the full path
			 * would be prefixed a second time and answer 404 for a record that is still there. */
			path = input.client.relativePath(call.url)
		} catch {
			continue
		}
		const after = await input.client.request("GET", path, { headers: input.auth(), operationId: read.operationId })
		if (after.status === 404 || after.status === 410) {
			grades.graded([op.operationId], DELETE_CHECK_ID)
			grades.prove(op.operationId, { call: call.seq, observation: { seq: after.seq, status: after.status } })
			continue
		}
		if (after.status < 200 || after.status >= 300) {
			/* A refused read (the caller's session ended, a role it lost) shows nothing about the
			 * record. Say so: going quiet would pass a delete nobody saw through. */
			input.findings
				.attributed([op.operationId])
				.ownedBy(DELETE_CHECK_ID)
				.unresolved(
					DELETE_CHECK_ID,
					op.entity ?? op.operationId,
					`${read.operationId} answered ${after.status} when reading ${path} back after ${op.operationId}, so whether the record is gone was not seen`,
				)
			continue
		}
		/* A delete of the whole collection has no item to read back: the read on its path is the
		 * list, and the empty list it leaves is the proof. */
		if (read.collection !== null) {
			const key = read.collection.key
			const listed = key === null ? after.responseBody : (after.responseBody as Record<string, unknown> | null)?.[key]
			if (Array.isArray(listed) && listed.length === 0) {
				grades.graded([op.operationId], DELETE_CHECK_ID)
				grades.prove(op.operationId, {
					call: call.seq,
					observation: { path: key === null ? "$" : `$.${key}`, seq: after.seq, value: "[]" },
				})
				continue
			}
		}
		const marker = op.softDelete ?? read.softDelete
		const body = after.responseBody as Record<string, unknown> | null
		const marked = marker === null ? undefined : body?.[marker]
		if (marker !== null && marked !== undefined && marked !== null) {
			grades.graded([op.operationId], DELETE_CHECK_ID)
			grades.prove(op.operationId, {
				call: call.seq,
				observation: { path: `$.${marker}`, seq: after.seq, value: String(marked) },
			})
			continue
		}
		grades.graded([op.operationId], DELETE_CHECK_ID)
		input.findings
			.attributed([op.operationId])
			.ownedBy(DELETE_CHECK_ID)
			.backend(
				DELETE_CHECK_ID,
				op.entity ?? op.operationId,
				"a deleted record is still readable",
				`${op.operationId} returned ${call.status}, and ${read.operationId} on the same path then returned ${after.status} with no deletion marker.`,
				[call, after],
			)
	}
}
