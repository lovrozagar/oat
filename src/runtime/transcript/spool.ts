/** Transcript bodies past a memory budget, moved to disk and read back on request. */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Exchange } from "../exchange.ts"

/** Bytes of transcript bodies kept in memory before the oldest move to disk. */
export const TRANSCRIPT_BODY_BUDGET = 32 * 1024 * 1024

/** Where a body went when it moved out of memory. */
export interface SpooledBody {
	spooled: number
}

export function isSpooledBody(value: unknown): value is SpooledBody {
	return value !== null && typeof value === "object" && typeof (value as SpooledBody).spooled === "number"
}

/**
 * Transcript bodies past a memory budget, on disk.
 *
 * The transcript keeps every exchange — checks judge it after the fact — but not every body in
 * memory: a run that read a few hundred large pages would otherwise hold them all. Bodies are
 * kept newest first up to the budget; older ones are written to a private directory, exactly as
 * they were (this is not the journal, which redacts), and read back on request.
 */
export class BodySpool {
	private readonly kept: Array<{ exchange: Exchange; bytes: number }> = []
	private held = 0
	/* One directory per spool. The promise, not its result, is shared: concurrent first writes
	 * that each made their own directory left all but the last one's bodies where no read looks. */
	private dir: Promise<string> | undefined

	constructor(private readonly budget = TRANSCRIPT_BODY_BUDGET) {}

	async keep(exchange: Exchange): Promise<void> {
		const bytes = exchange.requestBytes + exchange.responseBytes
		this.kept.push({ bytes, exchange })
		this.held += bytes
		while (this.held > this.budget && this.kept.length > 1) {
			/* More than one is kept, so there is an oldest. */
			const oldest = this.kept.shift() as { exchange: Exchange; bytes: number }
			this.held -= oldest.bytes
			await this.write(oldest.exchange)
		}
	}

	async hydrate(exchange: Exchange): Promise<Exchange> {
		if (!isSpooledBody(exchange.responseBody) && !isSpooledBody(exchange.requestBody)) return exchange
		const seq = (isSpooledBody(exchange.responseBody) ? exchange.responseBody : exchange.requestBody) as SpooledBody
		/* A marker exists only once a write has made the directory. */
		const dir = await (this.dir as Promise<string>)
		const saved = JSON.parse(await readFile(join(dir, `${seq.spooled}.json`), "utf8")) as {
			requestBody?: unknown
			responseBody?: unknown
		}
		return { ...exchange, requestBody: saved.requestBody, responseBody: saved.responseBody }
	}

	async dispose(): Promise<void> {
		const dir = this.dir
		if (dir === undefined) return
		this.dir = undefined
		await rm(await dir, { force: true, recursive: true })
	}

	private async write(exchange: Exchange): Promise<void> {
		const dir = await (this.dir ??= mkdtemp(join(tmpdir(), "oat-transcript-")))
		const body = { requestBody: exchange.requestBody, responseBody: exchange.responseBody }
		await writeFile(join(dir, `${exchange.seq}.json`), JSON.stringify(body))
		const marker: SpooledBody = { spooled: exchange.seq }
		exchange.requestBody = exchange.requestBody === undefined ? undefined : marker
		exchange.responseBody = exchange.responseBody === undefined ? undefined : marker
	}
}
