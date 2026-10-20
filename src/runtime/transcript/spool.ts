/** Transcript bodies past a memory budget, moved to disk and read back on request. */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Exchange } from "../exchange.ts"

/** Bytes of transcript bodies kept in memory before the oldest move to disk. */
export const TRANSCRIPT_BODY_BUDGET = 32 * 1024 * 1024

/** How much of the transcript's bodies stays in memory, and where the rest goes. */
export interface SpoolOptions {
	/** Bytes of bodies kept in memory before the oldest move to disk. Default `TRANSCRIPT_BODY_BUDGET`. */
	memoryBytes?: number | undefined
	/** Where the spool makes its private directory. The system's temporary directory by default. */
	dir?: string | undefined
}

/* The spool's private directory, and the exit listener that removes it if the process ends first. */
interface SpoolDir {
	path: string
	onExit: () => void
}

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
 * kept newest first up to the budget; older ones are written to a private directory and read back
 * on request, exactly as they were: checks judge the real body, so it is not redacted. It is
 * encrypted instead, under a key only this spool holds in memory, so a login's tokens never rest on
 * disk readable, not even in a directory a crashed run left behind.
 */
export class BodySpool {
	private readonly kept: Array<{ exchange: Exchange; bytes: number }> = []
	private held = 0
	/* One directory per spool. The promise, not its result, is shared: concurrent first writes
	 * that each made their own directory left all but the last one's bodies where no read looks. */
	private dir: Promise<SpoolDir> | undefined

	private readonly budget: number
	private readonly root: string
	/* The key, drawn once and held only here: never logged, never serialized. */
	readonly #key = randomBytes(32)

	constructor(options: SpoolOptions = {}) {
		this.budget = options.memoryBytes ?? TRANSCRIPT_BODY_BUDGET
		this.root = options.dir ?? tmpdir()
	}

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
		const { path } = await (this.dir as Promise<SpoolDir>)
		const saved = JSON.parse(this.open(await readFile(join(path, `${seq.spooled}.bin`)), seq.spooled)) as {
			requestBody?: unknown
			responseBody?: unknown
		}
		return { ...exchange, requestBody: saved.requestBody, responseBody: saved.responseBody }
	}

	async dispose(): Promise<void> {
		const dir = this.dir
		if (dir === undefined) return
		this.dir = undefined
		/* Awaited first: a directory still being made has its exit listener only once it exists. */
		const { path, onExit } = await dir
		process.off("exit", onExit)
		await rm(path, { force: true, recursive: true })
	}

	/* The private directory, made once, and removed on exit if nothing disposes of it first: a second Ctrl-C exits at once. */
	async #made(): Promise<SpoolDir> {
		const path = await mkdtemp(join(this.root, "oat-transcript-"))
		const onExit = (): void => rmSync(path, { force: true, recursive: true })
		process.on("exit", onExit)
		return { onExit, path }
	}

	private async write(exchange: Exchange): Promise<void> {
		const { path } = await (this.dir ??= this.#made())
		const body = { requestBody: exchange.requestBody, responseBody: exchange.responseBody }
		await writeFile(join(path, `${exchange.seq}.bin`), this.seal(JSON.stringify(body)))
		const marker: SpooledBody = { spooled: exchange.seq }
		exchange.requestBody = exchange.requestBody === undefined ? undefined : marker
		exchange.responseBody = exchange.responseBody === undefined ? undefined : marker
	}

	/* AES-256-GCM under this spool's key: a fresh 96-bit nonce, the tag, then the ciphertext. */
	private seal(text: string): Buffer {
		const iv = randomBytes(12)
		const cipher = createCipheriv("aes-256-gcm", this.#key, iv)
		const sealed = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
		return Buffer.concat([iv, cipher.getAuthTag(), sealed])
	}

	/* The tag is checked before a byte is trusted: an altered or truncated file throws, never decrypts to garbage. */
	private open(file: Buffer, seq: number): string {
		try {
			const decipher = createDecipheriv("aes-256-gcm", this.#key, file.subarray(0, 12), { authTagLength: 16 })
			decipher.setAuthTag(file.subarray(12, 28))
			return Buffer.concat([decipher.update(file.subarray(28)), decipher.final()]).toString("utf8")
		} catch (error) {
			throw new Error(`the spooled body of exchange ${seq} failed authentication: altered or truncated`, {
				cause: error,
			})
		}
	}
}
