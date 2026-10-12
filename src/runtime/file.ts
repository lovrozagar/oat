/**
 * A file built after the start response. Poll the status the document names, then read the
 * file. The download passes when that body contains the caller's address.
 */

import type { PrincipalAuth } from "../config/define-config.ts"
import type { Client, Exchange } from "./client.ts"
import type { FindingCollector } from "./finding.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"
import type { GradeLedger } from "./scope.ts"
import { parseRouteRef } from "../spec/load.ts"
import { sleep } from "./poll.ts"
import { readPath } from "./path.ts"
import { fillPath, requestSchemaOf } from "./world.ts"

export const FILE_CHECK_ID = "file.body-contains-the-caller"

const FILE_TIMEOUT_MS = 120_000
const FILE_POLL_MS = 1_000
const MIN_PRODUCED_LENGTH = 12

interface FileSpec {
	until: string
	ready: string
	produce?: string
	poll?: string
	contains: "caller" | "produced"
	timeoutMs: number
	pollIntervalMs: number
}

export async function runFiles(input: {
	auth: () => Record<string, string>
	authFlow?: PrincipalAuth
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	model: SpecModel
	roots?: Record<string, string>
}): Promise<void> {
	const artifacts = input.model.operations.filter((op) => {
		const spec = fileSpec(input.model, op)
		if (spec === null) return false
		if (input.mode === "full") return true
		const produce = produceOp(input.model, op, spec)
		return input.inScope(op.operationId) || (produce !== undefined && input.inScope(produce.operationId))
	})
	const flow = authFlowOf(input.authFlow)
	const email = flow === null ? undefined : signupEmail(flow)
	const password = flow === null ? undefined : signupPassword(flow)
	for (const artifact of artifacts) {
		const spec = fileSpec(input.model, artifact)
		if (spec === null) continue
		const produce = produceOp(input.model, artifact, spec)
		const poll = spec === null ? undefined : pollOp(input.model, artifact, produce, spec)
		const ids = [artifact.operationId]
		if (produce !== undefined) ids.push(produce.operationId)
		const blame = input.findings.attributed(ids).ownedBy(FILE_CHECK_ID)
		if (produce === undefined || poll === undefined) {
			blame.backend(
				FILE_CHECK_ID,
				artifact.entity ?? "caller",
				"the file was not prepared",
				`${artifact.operationId} had no start or no status read.`,
				[],
			)
			input.grades.graded(ids, FILE_CHECK_ID)
			continue
		}
		if (spec.contains === "caller" && (email === undefined || !email.includes("@"))) {
			blame.backend(
				FILE_CHECK_ID,
				"caller",
				"the caller address was missing",
				`${artifact.operationId} had no signup address to find in the file.`,
				[],
			)
			input.grades.graded(ids, FILE_CHECK_ID)
			continue
		}
		const scope = input.roots ?? {}
		let producePath: string
		let pollPath: string
		try {
			producePath = fillPath(produce.path, scope)
			pollPath = fillPath(poll.path, scope)
		} catch (error) {
			blame.backend(
				FILE_CHECK_ID,
				produce.entity ?? "caller",
				"the file path had no scope",
				error instanceof Error ? error.message : String(error),
				[],
			)
			input.grades.graded(ids, FILE_CHECK_ID)
			continue
		}
		let called = await input.client.request(produce.method, producePath, {
			headers: input.auth,
			operationId: produce.operationId,
			...queryOf(input.model, produce),
		})
		if (needsReauth(called) && password !== undefined) {
			await reauth(input, password)
			called = await input.client.request(produce.method, producePath, {
				headers: input.auth,
				operationId: produce.operationId,
				...queryOf(input.model, produce),
			})
		}
		if (called.status < 200 || called.status >= 300) {
			blame.backend(
				FILE_CHECK_ID,
				produce.entity ?? "caller",
				"the file was not started",
				`${produce.operationId} returned ${called.status}.`,
				[called],
			)
			input.grades.graded(ids, FILE_CHECK_ID)
			continue
		}
		const waited = await pollUntil(input, poll, pollPath, spec)
		const shown = waited.ready
			? artifact.operationId === poll.operationId
				? waited.exchange
				: await input.client.request(artifact.method, fillPath(artifact.path, scope), {
						headers: input.auth,
						operationId: artifact.operationId,
					})
			: undefined
		if (shown === undefined || !fileShows(spec, email, called, shown)) {
			blame.backend(
				FILE_CHECK_ID,
				artifact.entity ?? "caller",
				"the file did not contain the caller",
				`${produce.operationId} returned ${called.status}, and ${artifact.operationId} did not contain this caller.`,
				shown === undefined ? [called, ...waited.exchanges] : [called, ...waited.exchanges, shown],
			)
		}
		input.grades.graded(ids, FILE_CHECK_ID)
	}
}

function fileSpec(model: SpecModel, op: OperationModel): FileSpec | null {
	const raw = model.rawOperations.get(op.operationId) as { "x-file"?: unknown } | undefined
	const tag = raw?.["x-file"]
	if (tag === null || typeof tag !== "object" || Array.isArray(tag)) return null
	const rec = tag as Record<string, unknown>
	if (typeof rec.until !== "string" || rec.until === "" || typeof rec.ready !== "string" || rec.ready === "") {
		return null
	}
	const spec: FileSpec = {
		contains: rec.contains === "produced" ? "produced" : "caller",
		pollIntervalMs:
			typeof rec.pollIntervalMs === "number" && rec.pollIntervalMs > 0 ? rec.pollIntervalMs : FILE_POLL_MS,
		ready: rec.ready,
		timeoutMs: typeof rec.timeoutMs === "number" && rec.timeoutMs > 0 ? rec.timeoutMs : FILE_TIMEOUT_MS,
		until: rec.until,
	}
	if (typeof rec.produce === "string" && rec.produce !== "") spec.produce = rec.produce
	if (typeof rec.poll === "string" && rec.poll !== "") spec.poll = rec.poll
	return spec
}

function produceOp(model: SpecModel, artifact: OperationModel, spec: FileSpec): OperationModel | undefined {
	if (spec.produce !== undefined) return model.byOperationId.get(spec.produce)
	let best: OperationModel | undefined
	for (const op of model.operations) {
		if (op.method !== "POST") continue
		if (!artifact.path.startsWith(`${op.path}/`)) continue
		if (best === undefined || op.path.length > best.path.length) best = op
	}
	return best
}

function pollOp(
	model: SpecModel,
	artifact: OperationModel,
	produce: OperationModel | undefined,
	spec: FileSpec,
): OperationModel | undefined {
	if (spec.poll !== undefined) return model.byOperationId.get(spec.poll)
	if (produce !== undefined && artifact.path.startsWith(`${produce.path}/`)) return invalidatedGet(model, produce)
	return artifact
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

async function pollUntil(
	input: { auth: () => Record<string, string>; client: Client },
	poll: OperationModel,
	path: string,
	spec: FileSpec,
): Promise<{ ready: boolean; exchange?: Exchange; exchanges: Exchange[] }> {
	const exchanges: Exchange[] = []
	const began = performance.now()
	while (performance.now() - began < spec.timeoutMs) {
		const exchange = await input.client.request(poll.method, path, {
			headers: input.auth,
			operationId: poll.operationId,
		})
		exchanges.push(exchange)
		if (exchange.status >= 200 && exchange.status < 300 && readPath(exchange.responseBody, spec.until) === spec.ready) {
			return { exchange, exchanges, ready: true }
		}
		await sleep(spec.pollIntervalMs)
	}
	return { exchanges, ready: false }
}

function fileShows(spec: FileSpec, email: string | undefined, produce: Exchange, file: Exchange): boolean {
	if (file.status < 200 || file.status >= 300) return false
	const text = bodyText(file.responseBody)
	if (spec.contains === "produced") {
		return claimedStrings(produce.responseBody).some((value) => text.includes(value))
	}
	return email !== undefined && text.includes(email)
}

function bodyText(body: unknown): string {
	if (typeof body === "string") return body
	if (body === null || body === undefined) return ""
	return JSON.stringify(body)
}

function claimedStrings(body: unknown): string[] {
	const out: string[] = []
	const walk = (value: unknown) => {
		if (typeof value === "string") {
			if (value.length >= MIN_PRODUCED_LENGTH) out.push(value)
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
	walk(body)
	return out
}

function queryOf(model: SpecModel, op: OperationModel): { query?: Record<string, string> } {
	const raw = model.rawOperations.get(op.operationId)
	const parameters = raw?.parameters
	if (!Array.isArray(parameters)) return {}
	const query: Record<string, string> = {}
	for (const parameter of parameters) {
		if (parameter === null || typeof parameter !== "object") continue
		const rec = parameter as { in?: unknown; name?: unknown; required?: unknown; schema?: { enum?: unknown } }
		if (rec.in !== "query" || rec.required !== true || typeof rec.name !== "string") continue
		const values = rec.schema?.enum
		const first = Array.isArray(values) ? values.find((item): item is string => typeof item === "string") : undefined
		if (first !== undefined) query[rec.name] = first
	}
	return Object.keys(query).length === 0 ? {} : { query }
}

async function reauth(
	input: { auth: () => Record<string, string>; client: Client; model: SpecModel },
	password: string,
): Promise<void> {
	const op = input.model.operations.find(
		(item) => /\/reauth$/.test(item.path) && "password" in propertyBag(requestSchemaOf(item, input.model)),
	)
	if (op === undefined) return
	await input.client.request(op.method, op.path, {
		body: { password },
		headers: input.auth,
		operationId: op.operationId,
	})
}

function needsReauth(exchange: Exchange): boolean {
	if (exchange.status !== 403) return false
	const key = stringField(exchange.responseBody, "error_key")
	if (key !== null && key.includes("reauth")) return true
	return JSON.stringify(exchange.responseBody ?? "").includes("reauth")
}

function stringField(body: unknown, key: string): string | null {
	if (body === null || typeof body !== "object") return null
	const value = (body as Record<string, unknown>)[key]
	return typeof value === "string" && value !== "" ? value : null
}

function authFlowOf(auth: PrincipalAuth | undefined): { steps: unknown[] } | null {
	if (auth === undefined || !("steps" in auth)) return null
	return auth
}

function signupEmail(spec: { steps: unknown[] }): string | undefined {
	for (const step of spec.steps) {
		if (step === null || typeof step !== "object" || !("body" in step)) continue
		const body = (step as { body?: unknown }).body
		if (body === null || typeof body !== "object" || !("email" in body)) continue
		const email = (body as { email?: unknown }).email
		if (typeof email === "string") return email
	}
	return undefined
}

function signupPassword(spec: { steps: unknown[] }): string | undefined {
	for (const step of spec.steps) {
		if (step === null || typeof step !== "object" || !("body" in step)) continue
		const body = (step as { body?: unknown }).body
		if (body === null || typeof body !== "object" || !("password" in body)) continue
		const password = (body as { password?: unknown }).password
		if (typeof password === "string") return password
	}
	return undefined
}

function propertyBag(schema: Record<string, unknown> | null): Record<string, unknown> {
	if (schema === null) return {}
	const properties = schema.properties
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return {}
	return properties as Record<string, unknown>
}
