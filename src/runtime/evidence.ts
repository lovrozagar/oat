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

/** Where `walk` gathers strings, and whether it keeps only ids. */
interface Harvest {
	into: string[]
	idsOnly: boolean
}

function walk(node: unknown, depth: number, harvest: Harvest): void {
	if (depth > 4 || node === null || typeof node !== "object") return
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (typeof value === "string" && value.length >= 6) {
			if (!harvest.idsOnly || key === "id" || key.endsWith("_id")) harvest.into.push(value)
		} else walk(value, depth + 1, harvest)
	}
}

/** Distinctive values a call put into the world: ids it returned, then long strings it sent. */
function tokensOf(exchange: Exchange): string[] {
	const ids: string[] = []
	const sent: string[] = []
	walk(exchange.responseBody, 0, { idsOnly: true, into: ids })
	walk(exchange.requestBody, 0, { idsOnly: false, into: sent })
	return [...new Set([...ids, ...sent])]
}

/** Where a search stands: the JSON path walked so far and how deep it is. */
interface Position {
	prefix: string
	depth: number
}

/** A JSON path (`[*]` for arrays) to a string node equal to `value`, or null. */
export function pathTo(body: unknown, value: string, at: Position = { depth: 0, prefix: "$" }): string | null {
	const { depth, prefix } = at
	if (depth > 6 || body === null || typeof body !== "object") return null
	if (Array.isArray(body)) {
		for (const item of body) {
			if (item === value) return `${prefix}[*]`
			const hit = pathTo(item, value, { depth: depth + 1, prefix: `${prefix}[*]` })
			if (hit !== null) return hit
		}
		return null
	}
	for (const [key, item] of Object.entries(body as Record<string, unknown>)) {
		if (item === value) return `${prefix}.${key}`
		const hit = pathTo(item, value, { depth: depth + 1, prefix: `${prefix}.${key}` })
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

/** Every string `pathTo` can reach in `body`. */
function stringsIn(body: unknown, into = new Set<string>(), depth = 0): Set<string> {
	if (depth > 6 || body === null || typeof body !== "object") return into
	for (const item of Array.isArray(body) ? body : Object.values(body as Record<string, unknown>)) {
		if (typeof item === "string") into.add(item)
		else stringsIn(item, into, depth + 1)
	}
	return into
}

/**
 * Where each value sits in the run, found once. Lanes run side by side, so how many exchanges part
 * a call from the one that shows it depends on what ran beside it, not on what the call did: every
 * search spans the whole run, and the index reads each body once rather than once per search.
 */
class RunIndex {
	readonly transcript: Exchange[]
	readonly client: Client
	#written: Promise<Map<string, number[]>> | undefined
	#shown: Promise<Map<string, number[]>> | undefined

	constructor(client: Client) {
		this.client = client
		/* Teardown reads check that cleanup worked; they are not evidence for what a check graded. */
		this.transcript = client.transcript.filter((exchange) => exchange.purpose !== "teardown" || !isRead(exchange))
	}

	/** Where the ok writes that put each value into the world sit, ascending. */
	written(): Promise<Map<string, number[]>> {
		return (this.#written ??= this.#gather((exchange) => !isRead(exchange) && ok(exchange), tokensOf))
	}

	/** Where the ok reads that show each string sit, ascending. */
	shown(): Promise<Map<string, number[]>> {
		return (this.#shown ??= this.#gather(isOkRead, (whole) => stringsIn(whole.responseBody)))
	}

	async #gather(take: (exchange: Exchange) => boolean, values: (whole: Exchange) => Iterable<string>) {
		const at = new Map<string, number[]>()
		for (const [index, exchange] of this.transcript.entries()) {
			if (!take(exchange)) continue
			for (const value of values(await this.client.hydrate(exchange))) {
				const positions = at.get(value)
				if (positions === undefined) at.set(value, [index])
				else positions.push(index)
			}
		}
		return at
	}
}

/** One operation's view of the run, with bodies read back through the client once each. */
class Journal {
	readonly transcript: Exchange[]
	readonly index: RunIndex
	readonly #cache = new Map<number, Exchange>()

	constructor(index: RunIndex) {
		this.index = index
		this.transcript = index.transcript
	}

	async whole(exchange: Exchange): Promise<Exchange> {
		const known = this.#cache.get(exchange.seq)
		if (known !== undefined) return known
		const hydrated = await this.index.client.hydrate(exchange)
		this.#cache.set(exchange.seq, hydrated)
		return hydrated
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
	for (const read of journal.transcript.slice(removal.index + 1)) {
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
	for (const prior of journal.transcript.slice(0, removal.index)) {
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
	for (const read of journal.transcript.slice(removal.index + 1)) {
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

/** The earliest position any of `values` sits at in `at` that `fits`, or undefined. */
function earliest(at: Map<string, number[]>, values: Iterable<string>, fits: (index: number) => boolean) {
	let first: number | undefined
	for (const value of values) {
		const index = at.get(value)?.find(fits)
		if (index !== undefined && (first === undefined || index < first)) first = index
	}
	return first
}

/** A read shows a value an earlier write put into the world: the earliest such write. */
async function readShown(journal: Journal, call: Exchange, index: number): Promise<PassEvidence | undefined> {
	const held = stringsIn(call.responseBody)
	const first = earliest(await journal.index.written(), held, (at) => at < index)
	if (first === undefined) return undefined
	const tokens = tokensOf(await journal.whole(journal.transcript[first] as Exchange))
	const value = tokens.find((token) => held.has(token)) as string
	return { call: call.seq, observation: { path: pathTo(call.responseBody, value) as string, seq: call.seq, value } }
}

/** A later read shows a value the write put into the world: the first such read. */
async function writeShown(journal: Journal, call: Exchange, index: number): Promise<PassEvidence | undefined> {
	const values = tokensOf(call)
	if (values.length === 0) return undefined
	const first = earliest(await journal.index.shown(), values, (at) => at > index)
	if (first === undefined) return undefined
	const read = journal.transcript[first] as Exchange
	const body = (await journal.whole(read)).responseBody
	const held = stringsIn(body)
	const value = values.find((token) => held.has(token)) as string
	return { call: call.seq, observation: { path: pathTo(body, value) as string, seq: read.seq, value } }
}

type Shown = (journal: Journal, call: Exchange, index: number) => Promise<PassEvidence | undefined>

function shownFor(method: string): Shown {
	if (method === "DELETE") return deleteShown
	return READS.has(method) ? readShown : writeShown
}

async function infer(op: OperationModel, run: RunIndex): Promise<PassEvidence | undefined> {
	const journal = new Journal(run)
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
 * first exchange anywhere in the run that holds a value the call put into the world. A write no later read
 * shows keeps only its call, and the report calls that pass `contract`.
 */
export async function proveFromTranscript(input: {
	model: SpecModel
	client: Client
	grades: GradeLedger
}): Promise<void> {
	const run = new RunIndex(input.client)
	for (const op of input.model.operations) {
		if (!input.grades.judged(op.operationId)) continue
		if (input.grades.evidence.get(op.operationId)?.observation !== undefined) continue
		const evidence = await infer(op, run)
		if (evidence !== undefined) input.grades.prove(op.operationId, evidence)
	}
}
