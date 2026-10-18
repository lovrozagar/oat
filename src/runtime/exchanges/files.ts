/** Whether a run keeps its exchanges, and the file each exchange is written to. */

export interface SaveExchangesOptions {
	/** CLI: true `--save-exchanges`, false `--no-save-exchanges`, omitted if neither. */
	flag?: boolean
	config?: boolean
	profile?: string
}

export function resolveSaveExchanges(options: SaveExchangesOptions): boolean {
	if (options.flag !== undefined) return options.flag
	if (options.config !== undefined) return options.config
	return options.profile !== "cheap"
}

export function sanitizeExchangeId(requestId: string): string {
	const cleaned = requestId
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^_+|_+$/g, "")
	return cleaned === "" ? "id" : cleaned.slice(0, 180)
}

export function exchangeFileStem(requestId: string, seq: number, taken: ReadonlySet<string>): string {
	const trimmed = requestId.trim()
	const base = trimmed === "" ? `seq-${seq}` : sanitizeExchangeId(trimmed)
	if (!taken.has(base)) return base
	const dup = `${base}-${seq}`
	if (!taken.has(dup)) return dup
	let n = 2
	while (taken.has(`${dup}-${n}`)) n += 1
	return `${dup}-${n}`
}
