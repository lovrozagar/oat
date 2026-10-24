/**
 * Persist every HTTP exchange under the run dir so a green run is still inspectable.
 *
 * Layout (next to `progress.tsv`):
 *   exchanges.jsonl              one line per Exchange.seq, join key = requestId = TSV req_id
 *   exchanges/<requestId>.json   full exchange (headers + described / spilled bodies)
 *   blobs/<sha256>               content-addressed bytes (multipart, binary, oversized text)
 *
 * Redaction is on by default. This is oat's journal, not a HAR file.
 */

import { existsSync } from "node:fs"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Redactor } from "../../security/redact.ts"
import type { RedirectHop } from "../cookies/redirect.ts"
import type { Exchange } from "../exchange.ts"
import { createBlobStore } from "./blobs.ts"
import { exchangeFileStem } from "./files.ts"
import { persistRequestBody, persistResponseBody } from "./persist.ts"

/** Index lines buffered before one append. */
const JOURNAL_BATCH = 64

export interface ExchangeMeta {
	check?: string
	entity?: string
	phase?: string
}

export interface ExchangeJournal {
	readonly dir: string
	readonly count: number
	record(exchange: Exchange, meta?: ExchangeMeta): Promise<void>
	/** Writes the index lines still buffered. Called once the run is over. */
	flush(): Promise<void>
}

/** The bodies of one exchange, as written. */
interface PersistedBodies {
	requestBody: unknown
	responseBody: unknown
}

/** The full exchange file: headers and URLs redacted, bodies as persisted. */
export interface JournalExchangeFile {
	at: number
	durationMs: number
	fixture?: string
	finalUrl?: string
	method: string
	operationId?: string
	requestBody: unknown
	requestHeaders: Record<string, string>
	requestId: string
	responseBody: unknown
	responseHeaders: Record<string, string>
	redirects?: RedirectHop[]
	seq: number
	status: number
	url: string
}

function exchangeFile(exchange: Exchange, bodies: PersistedBodies, redactor: Redactor): JournalExchangeFile {
	return {
		at: exchange.at,
		durationMs: exchange.durationMs,
		...(exchange.fixture === undefined ? {} : { fixture: exchange.fixture }),
		...(exchange.finalUrl === undefined ? {} : { finalUrl: exchange.finalUrl }),
		method: exchange.method,
		...(exchange.operationId === undefined ? {} : { operationId: exchange.operationId }),
		requestBody: bodies.requestBody,
		requestHeaders: redactor.headers(exchange.requestHeaders),
		requestId: exchange.requestId,
		responseBody: bodies.responseBody,
		responseHeaders: redactor.headers(exchange.responseHeaders),
		...(exchange.redirects === undefined
			? {}
			: {
					redirects: exchange.redirects.map((hop) => ({
						responseHeaders: redactor.headers(hop.responseHeaders),
						status: hop.status,
						url: redactor.url(hop.url),
					})),
				}),
		seq: exchange.seq,
		status: exchange.status,
		url: redactor.url(exchange.url),
	}
}

/** What an index line carries beside the exchange: its tags, and the file the exchange is in. */
interface IndexMeta extends ExchangeMeta {
	file: string
}

/** The exchange's line in `exchanges.jsonl`, pointing at its file. */
export interface JournalIndexLine extends IndexMeta {
	at: number
	durationMs: number
	method: string
	requestBytes: number
	requestId: string
	responseBytes: number
	seq: number
	status: number
	url: string
	operationId?: string
	fixture?: string
	finalUrl?: string
	/** How many redirects the exchange followed; the hops are in its file. */
	redirects?: number
}

function indexLine(exchange: Exchange, meta: IndexMeta, redactor: Redactor): JournalIndexLine {
	const line: JournalIndexLine = {
		at: exchange.at,
		durationMs: exchange.durationMs,
		file: meta.file,
		method: exchange.method,
		requestBytes: exchange.requestBytes,
		requestId: exchange.requestId,
		responseBytes: exchange.responseBytes,
		seq: exchange.seq,
		status: exchange.status,
		url: redactor.url(exchange.url),
	}
	if (exchange.operationId !== undefined) line.operationId = exchange.operationId
	if (exchange.fixture !== undefined) line.fixture = exchange.fixture
	if (exchange.finalUrl !== undefined) line.finalUrl = exchange.finalUrl
	if (exchange.redirects !== undefined) line.redirects = exchange.redirects.length
	if (meta.check !== undefined) line.check = meta.check
	if (meta.entity !== undefined) line.entity = meta.entity
	if (meta.phase !== undefined) line.phase = meta.phase
	return line
}

/** A file name no exchange in this journal, or on disk from an earlier one, has taken. */
function claimStem(exchange: Exchange, dir: string, taken: Set<string>): string {
	let stem = exchangeFileStem(exchange.requestId, exchange.seq, taken)
	const exchangesDir = join(dir, "exchanges")
	while (existsSync(join(exchangesDir, `${stem}.json`))) {
		taken.add(stem)
		stem = exchangeFileStem(exchange.requestId, exchange.seq, taken)
	}
	taken.add(stem)
	return stem
}

/** The directories, made once, on the first record. */
function lazyDirs(dir: string): () => Promise<void> {
	let ready: Promise<void> | undefined
	return async (): Promise<void> => {
		if (ready === undefined) {
			ready = Promise.all([
				mkdir(join(dir, "exchanges"), { recursive: true }),
				mkdir(join(dir, "blobs"), { recursive: true }),
			]).then(() => undefined)
		}
		await ready
	}
}

export function createExchangeJournal(dir: string, redactor: Redactor): ExchangeJournal {
	const taken = new Set<string>()
	const store = createBlobStore(dir, redactor)
	const ensure = lazyDirs(dir)
	let count = 0
	/* Index lines and exchange files are written in batches: one awaited write per exchange was
	 * most of the journal's cost. */
	let pending: string[] = []
	let pendingFiles: Array<{ path: string; content: string }> = []
	const flush = async (): Promise<void> => {
		/* An exchange's file and its index line are queued together. */
		if (pending.length === 0) return
		const lines = pending
		const files = pendingFiles
		pending = []
		pendingFiles = []
		await Promise.all(files.map((file) => writeFile(file.path, file.content)))
		await appendFile(join(dir, "exchanges.jsonl"), lines.join(""))
	}

	return {
		get count() {
			return count
		},
		get dir() {
			return dir
		},
		flush,
		async record(exchange, meta = {}) {
			await ensure()
			/* A secret the response issues may already sit in the request, headers or URL written first. */
			redactor.learn(exchange.responseBody)
			const requestBody = await persistRequestBody(exchange.requestBody, store)
			const responseBody = await persistResponseBody(exchange, store)
			const rel = `exchanges/${claimStem(exchange, dir, taken)}.json`
			const file = exchangeFile(exchange, { requestBody, responseBody }, redactor)
			pendingFiles.push({ content: `${JSON.stringify(file, null, 2)}\n`, path: join(dir, rel) })
			pending.push(`${JSON.stringify(indexLine(exchange, { ...meta, file: rel }, redactor))}\n`)
			if (pending.length >= JOURNAL_BATCH) await flush()
			count += 1
		},
	}
}
