/**
 * Server-Sent Events frames.
 *
 * A success response that lists `text/event-stream` is a stream, not a JSON document. Split
 * `event:` / `data:` the way the browser does; parse `data` as JSON only when it looks like JSON.
 * Feed chunks through `SseParser` so a live stream never has to become one concatenated string.
 */

export interface SseEvent {
	event: string
	/** JSON object/array when `data` starts with `{` / `[` and parses; otherwise the raw string. */
	data: unknown
	raw: string
}

/** Citeable SSE frame: event name + parsed data, without the duplicated `raw` payload. */
export type SseFrame = Pick<SseEvent, "event" | "data">

/**
 * Incremental SSE decoder. Incomplete lines stay in an internal buffer; dispatched frames
 * are the only retained payload.
 */
export class SseParser {
	private buffer = ""
	private event = "message"
	private readonly dataLines: string[] = []
	readonly events: SseEvent[] = []

	push(chunk: string): void {
		this.buffer += chunk
		for (;;) {
			const newline = this.buffer.indexOf("\n")
			if (newline < 0) break
			let line = this.buffer.slice(0, newline)
			this.buffer = this.buffer.slice(newline + 1)
			if (line.endsWith("\r")) line = line.slice(0, -1)
			this.handleLine(line)
		}
	}

	/** Treat any remainder as a final line, then flush a trailing frame. */
	finish(): SseEvent[] {
		if (this.buffer.length > 0) {
			this.handleLine(this.buffer)
			this.buffer = ""
		}
		this.flush()
		return this.events
	}

	private handleLine(line: string): void {
		if (line === "") {
			this.flush()
			return
		}
		if (line.startsWith(":")) return
		const colon = line.indexOf(":")
		const field = colon < 0 ? line : line.slice(0, colon)
		let value = colon < 0 ? "" : line.slice(colon + 1)
		if (value.startsWith(" ")) value = value.slice(1)
		if (field === "event") this.event = value
		else if (field === "data") this.dataLines.push(value)
	}

	private flush(): void {
		if (this.dataLines.length === 0) {
			this.event = "message"
			return
		}
		const raw = this.dataLines.join("\n")
		this.dataLines.length = 0
		const name = this.event
		this.event = "message"
		this.events.push({ data: parseData(raw), event: name, raw })
	}
}

/** Split a complete SSE body into frames. An empty `data` is not dispatched. */
export function parseSse(text: string): SseEvent[] {
	const parser = new SseParser()
	parser.push(text)
	return parser.finish()
}

/** SSE text when the body is a string that carries `event:` / `data:` frames, or already-parsed frames. */
export function sseEvents(body: unknown): SseEvent[] | null {
	if (isSseFrameList(body)) {
		return body.map((frame) => ({
			data: frame.data,
			event: frame.event,
			raw: typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data),
		}))
	}
	if (typeof body !== "string") return null
	if (!/^(?:event|data):/m.test(body)) return null
	return parseSse(body)
}

/** Drop the duplicated `raw` field so a transcript can keep frames without twice the bytes. */
export function sseFramesOf(events: readonly SseEvent[]): SseFrame[] {
	return events.map((event) => ({ data: event.data, event: event.event }))
}

export function isSseFrameList(body: unknown): body is SseFrame[] {
	if (!Array.isArray(body) || body.length === 0) return false
	return body.every(isSseFrame)
}

function isSseFrame(item: unknown): item is SseFrame {
	if (item === null || typeof item !== "object") return false
	const rec = item as { event?: unknown; data?: unknown }
	return typeof rec.event === "string" && "data" in rec
}

function parseData(raw: string): unknown {
	const trimmed = raw.trimStart()
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return raw
	try {
		return JSON.parse(raw) as unknown
	} catch {
		return raw
	}
}
