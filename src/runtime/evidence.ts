/**
 * The exchanges behind a matrix pass. A check that passed proved a property; the report also
 * names the call and the later exchange that shows it, so a reader can audit the claim without
 * trusting oat. Bodies are read through the client, which may have moved older ones to disk.
 */

import type { OperationModel, SpecModel } from "../spec/graph.ts"
import type { Client, Exchange } from "./client.ts"
import type { GradeLedger, PassEvidence } from "./scope.ts"

const READS = new Set(["GET", "HEAD"])
/* How far either side of a call to look. Bounded, so a long run does not reread its whole journal. */
const WINDOW = 400

function ok(exchange: Exchange): boolean {
	return exchange.status >= 200 && exchange.status < 300
}

function pathOf(url: string): string {
	try {
		return new URL(url).pathname
	} catch {
		return url
	}
}

function walk(node: unknown, depth: number, into: string[], idsOnly: boolean): void {
	if (depth > 4 || node === null || typeof node !== "object") return
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (typeof value === "string" && value.length >= 6) {
			if (!idsOnly || key === "id" || key.endsWith("_id")) into.push(value)
		} else walk(value, depth + 1, into, idsOnly)
	}
}

/** Distinctive values a call put into the world: ids it returned, then long strings it sent. */
function tokensOf(exchange: Exchange): string[] {
	const ids: string[] = []
	const sent: string[] = []
	walk(exchange.responseBody, 0, ids, true)
	walk(exchange.requestBody, 0, sent, false)
	return [...new Set([...ids, ...sent])]
}

/** A JSON path (`[*]` for arrays) to a string node equal to `value`, or null. */
export function pathTo(body: unknown, value: string, prefix = "$", depth = 0): string | null {
	if (depth > 6 || body === null || typeof body !== "object") return null
	if (Array.isArray(body)) {
		for (const item of body) {
			if (item === value) return `${prefix}[*]`
			const hit = pathTo(item, value, `${prefix}[*]`, depth + 1)
			if (hit !== null) return hit
		}
		return null
	}
	for (const [key, item] of Object.entries(body as Record<string, unknown>)) {
		if (item === value) return `${prefix}.${key}`
		const hit = pathTo(item, value, `${prefix}.${key}`, depth + 1)
		if (hit !== null) return hit
	}
	return null
}

async function infer(op: OperationModel, client: Client): Promise<PassEvidence | undefined> {
	const transcript = client.transcript
	const at = new Map(transcript.map((exchange, index) => [exchange.seq, index]))
	const cache = new Map<number, Exchange>()
	const whole = async (exchange: Exchange): Promise<Exchange> => {
		const known = cache.get(exchange.seq)
		if (known !== undefined) return known
		const hydrated = await client.hydrate(exchange)
		cache.set(exchange.seq, hydrated)
		return hydrated
	}
	const calls = transcript.filter((exchange) => exchange.operationId === op.operationId && ok(exchange))
	const last = calls.at(-1)
	if (last === undefined) return undefined
	const method = op.method.toUpperCase()
	for (const stored of calls.toReversed()) {
		const index = at.get(stored.seq) ?? 0
		const call = await whole(stored)
		if (method === "DELETE") {
			const segments = pathOf(call.url).split("/")
			const id = decodeURIComponent(segments.pop() ?? "")
			const collection = segments.join("/")
			for (const read of transcript.slice(index + 1, index + 1 + WINDOW)) {
				if (!READS.has(read.method.toUpperCase())) continue
				if ((read.status === 404 || read.status === 410) && pathOf(read.url) === pathOf(call.url)) {
					return { call: call.seq, observation: { seq: read.seq, status: read.status } }
				}
				if (ok(read) && id !== "" && pathOf(read.url) === collection) {
					if (pathTo((await whole(read)).responseBody, id) === null) {
						return { call: call.seq, observation: { absent: true, path: "$", seq: read.seq, value: id } }
					}
				}
			}
			continue
		}
		if (READS.has(method)) {
			for (const write of transcript.slice(Math.max(0, index - WINDOW), index)) {
				if (READS.has(write.method.toUpperCase()) || !ok(write)) continue
				for (const value of tokensOf(await whole(write))) {
					const path = pathTo(call.responseBody, value)
					if (path !== null) return { call: call.seq, observation: { path, seq: call.seq, value } }
				}
			}
			continue
		}
		const values = tokensOf(call)
		if (values.length === 0) continue
		for (const read of transcript.slice(index + 1, index + 1 + WINDOW)) {
			if (!READS.has(read.method.toUpperCase()) || !ok(read)) continue
			const body = (await whole(read)).responseBody
			for (const value of values) {
				const path = pathTo(body, value)
				if (path !== null) return { call: call.seq, observation: { path, seq: read.seq, value } }
			}
		}
	}
	return { call: last.seq }
}

/**
 * Evidence for every operation a check graded without naming its exchanges: the call, and the
 * first nearby exchange that holds a value the call put into the world. A write no later read
 * shows keeps only its call, and the report calls that pass `contract`.
 */
export async function proveFromTranscript(input: {
	model: SpecModel
	client: Client
	grades: GradeLedger
}): Promise<void> {
	for (const op of input.model.operations) {
		if ((input.grades.ran.get(op.operationId)?.size ?? 0) === 0) continue
		if (input.grades.evidence.get(op.operationId)?.observation !== undefined) continue
		const evidence = await infer(op, input.client)
		if (evidence !== undefined) input.grades.prove(op.operationId, evidence)
	}
}
