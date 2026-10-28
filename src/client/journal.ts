/** The client's transcript: every exchange, compacted, and indexed by operation and entity. */

import type { Redactor } from "../security/redact.ts"
import { type Exchange, isBodyRef, type SchemaVerdict } from "../runtime/exchange.ts"
import { BodySpool, type SpoolOptions } from "../runtime/transcript/spool.ts"
import { releaseTranscriptBodies } from "../runtime/transcript/release.ts"

export class Journal {
	/**
	 * Every exchange, with bodies compacted for memory. The exchange a request returns to its
	 * caller is never compacted: it holds the real body, however large.
	 */
	readonly transcript: Exchange[] = []
	private readonly byOperationId = new Map<string, Exchange[]>()
	private readonly byEntity = new Map<string, Exchange[]>()
	private readonly stored = new Map<number, Exchange>()
	private readonly spool: BodySpool
	private readonly validateAtCapture: ((exchange: Exchange) => SchemaVerdict | undefined) | undefined

	constructor(
		private readonly redactor: Redactor,
		options: {
			spool?: SpoolOptions
			validateAtCapture?: (exchange: Exchange) => SchemaVerdict | undefined
		} = {},
	) {
		this.spool = new BodySpool(options.spool ?? {})
		this.validateAtCapture = options.validateAtCapture
	}

	/**
	 * Keeps a compacted copy. The caller's exchange is left whole: a check reading a 300 KiB page
	 * must see the page, not a hash of it. A response body kept only by reference is validated
	 * against its documented schema now, while it is whole, and the verdict kept beside it.
	 */
	async record(exchange: Exchange, entity: string | undefined): Promise<void> {
		const stored: Exchange = { ...exchange }
		await releaseTranscriptBodies(stored, this.redactor)
		if (isBodyRef(stored.responseBody) && !isBodyRef(exchange.responseBody)) {
			const verdict = this.validateAtCapture?.(exchange)
			if (verdict !== undefined) stored.schemaVerdict = verdict
		}
		this.transcript.push(stored)
		this.stored.set(exchange.seq, stored)
		await this.spool.keep(stored)
		if (stored.operationId !== undefined) append(this.byOperationId, stored.operationId, stored)
		if (entity !== undefined) append(this.byEntity, entity, stored)
	}

	/** Marks an answer that was asked again: only the final answer is the backend's verdict. */
	supersede(exchange: Exchange): void {
		const stored = this.stored.get(exchange.seq)
		if (stored !== undefined) stored.superseded = true
	}

	/** Exchanges that resolved to `operationId`, in order. */
	exchangesFor(operationId: string): readonly Exchange[] {
		return this.byOperationId.get(operationId) ?? []
	}

	/** Exchanges that resolved to an operation of `entity`, in order. */
	exchangesForEntity(entity: string): readonly Exchange[] {
		return this.byEntity.get(entity) ?? []
	}

	/**
	 * The exchange with its bodies, wherever they are kept. The transcript holds the most recent
	 * bodies in memory and moves older ones to disk once they pass a budget; a reader that judges
	 * bodies from the transcript — rather than from the exchange a request returned — asks here.
	 */
	hydrate(exchange: Exchange): Promise<Exchange> {
		return this.spool.hydrate(exchange)
	}

	/** Removes the bodies moved to disk. */
	async dispose(): Promise<void> {
		await this.spool.dispose()
	}
}

function append(index: Map<string, Exchange[]>, key: string, exchange: Exchange): void {
	const list = index.get(key) ?? []
	list.push(exchange)
	index.set(key, list)
}
