/**
 * The exchanges behind a matrix pass. A check that passed proved a property; the report also
 * names the call and the later exchange that shows it, so a reader can audit the claim without
 * trusting oat. Bodies are read through the client, which may have moved older ones to disk.
 */

import type { OperationModel, SpecModel } from "../spec/graph/types.ts"
import type { Client } from "../client/client.ts"
import type { Exchange } from "./exchange.ts"
import type { GradeLedger, PassEvidence } from "./grades.ts"

const READS: ReadonlySet<string> = /* @__PURE__ */ new Set(["GET", "HEAD"])
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

/** `ancestor` is `path` or a path above it, segment by segment. */
function isAncestor(ancestor: string, path: string): boolean {
	return ancestor === path || path.startsWith(`${ancestor}/`)
}

function isRead(exchange: Exchange): boolean {
	return READS.has(exchange.method.toUpperCase())
}

/** A successful read: what can show a value is (or no longer is) in the world. */
function isOkRead(exchange: Exchange): boolean {
	return isRead(exchange) && ok(exchange)
}

/** The run's exchanges, with bodies read back through the client once each. */
class Journal {
	readonly transcript: Exchange[]
	readonly #client: Client
	readonly #cache = new Map<number, Exchange>()

	constructor(client: Client) {
		this.#client = client
		/* Teardown reads check that cleanup worked; they are not evidence for what a check graded. */
		this.transcript = client.transcript.filter((exchange) => exchange.purpose !== "teardown" || !isRead(exchange))
	}

	async whole(exchange: Exchange): Promise<Exchange> {
		const known = this.#cache.get(exchange.seq)
		if (known !== undefined) return known
		const hydrated = await this.#client.hydrate(exchange)
		this.#cache.set(exchange.seq, hydrated)
		return hydrated
	}

	/** Up to `WINDOW` exchanges before the one at `index`. */
	before(index: number): Exchange[] {
		return this.transcript.slice(Math.max(0, index - WINDOW), index)
	}

	/** Up to `WINDOW` exchanges after the one at `index`. */
	after(index: number): Exchange[] {
		return this.transcript.slice(index + 1, index + 1 + WINDOW)
	}

	async holds(exchange: Exchange, value: string): Promise<boolean> {
		return pathTo((await this.whole(exchange)).responseBody, value) !== null
	}
}

/** A delete as its path states it: the collection it was made on, and the id it removed. */
interface Removal {
	call: Exchange
	index: number
	path: string
	collection: string
	id: string
}

function removalOf(call: Exchange, index: number): Removal {
	const path = pathOf(call.url)
	const cut = path.lastIndexOf("/")
	return { call, collection: path.slice(0, Math.max(cut, 0)), id: decodeURIComponent(path.slice(cut + 1)), index, path }
}

function absent(removal: Removal, read: Exchange): PassEvidence {
	return { call: removal.call.seq, observation: { absent: true, path: "$", seq: read.seq, value: removal.id } }
}

/** A later read of the item that is gone, or of its collection that no longer lists it. */
async function shownByOwnRead(journal: Journal, removal: Removal): Promise<PassEvidence | undefined> {
	for (const read of journal.after(removal.index)) {
		if (!isRead(read)) continue
		if ((read.status === 404 || read.status === 410) && pathOf(read.url) === removal.path) {
			return { call: removal.call.seq, observation: { seq: read.seq, status: read.status } }
		}
		if (ok(read) && removal.id !== "" && pathOf(read.url) === removal.collection) {
			if (!(await journal.holds(read, removal.id))) return absent(removal, read)
		}
	}
	return undefined
}

/** Whether an earlier read of `path` held the id. */
async function heldBefore(journal: Journal, removal: Removal, path: string): Promise<boolean> {
	for (const prior of journal.before(removal.index)) {
		if (isOkRead(prior) && pathOf(prior.url) === path && (await journal.holds(prior, removal.id))) return true
	}
	return false
}

/**
 * A nested item with no read of its own (a column inside its table) shows through an ancestor:
 * the same ancestor read held the id before the call and lacks it after.
 */
async function shownByAncestor(journal: Journal, removal: Removal): Promise<PassEvidence | undefined> {
	if (removal.id === "") return undefined
	for (const read of journal.after(removal.index)) {
		if (!isOkRead(read)) continue
		const path = pathOf(read.url)
		if (!isAncestor(path, removal.collection) || (await journal.holds(read, removal.id))) continue
		if (await heldBefore(journal, removal, path)) return absent(removal, read)
	}
	return undefined
}

async function deleteShown(journal: Journal, call: Exchange, index: number): Promise<PassEvidence | undefined> {
	const removal = removalOf(call, index)
	return (await shownByOwnRead(journal, removal)) ?? (await shownByAncestor(journal, removal))
}

/** A read shows a value an earlier write put into the world. */
async function readShown(journal: Journal, call: Exchange, index: number): Promise<PassEvidence | undefined> {
	for (const write of journal.before(index)) {
		if (isRead(write) || !ok(write)) continue
		for (const value of tokensOf(await journal.whole(write))) {
			const path = pathTo(call.responseBody, value)
			if (path !== null) return { call: call.seq, observation: { path, seq: call.seq, value } }
		}
	}
	return undefined
}

/** A later read shows a value the write put into the world. */
async function writeShown(journal: Journal, call: Exchange, index: number): Promise<PassEvidence | undefined> {
	const values = tokensOf(call)
	if (values.length === 0) return undefined
	for (const read of journal.after(index)) {
		if (!isOkRead(read)) continue
		const body = (await journal.whole(read)).responseBody
		for (const value of values) {
			const path = pathTo(body, value)
			if (path !== null) return { call: call.seq, observation: { path, seq: read.seq, value } }
		}
	}
	return undefined
}

type Shown = (journal: Journal, call: Exchange, index: number) => Promise<PassEvidence | undefined>

function shownFor(method: string): Shown {
	if (method === "DELETE") return deleteShown
	return READS.has(method) ? readShown : writeShown
}

async function infer(op: OperationModel, client: Client): Promise<PassEvidence | undefined> {
	const journal = new Journal(client)
	const calls = journal.transcript.flatMap((exchange, index) =>
		exchange.operationId === op.operationId && ok(exchange) ? [{ exchange, index }] : [],
	)
	const last = calls.at(-1)
	if (last === undefined) return undefined
	const shown = shownFor(op.method.toUpperCase())
	for (const { exchange, index } of calls.toReversed()) {
		const evidence = await shown(journal, await journal.whole(exchange), index)
		if (evidence !== undefined) return evidence
	}
	return { call: last.exchange.seq }
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
