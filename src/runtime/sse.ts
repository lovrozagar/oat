/**
 * Server-Sent Events frames.
 *
 * A success response that lists `text/event-stream` is a stream, not a JSON document. Split
 * `event:` / `data:` the way the browser does; parse `data` as JSON only when it looks like JSON.
 */

export interface SseEvent {
	event: string
	/** JSON object/array when `data` starts with `{` / `[` and parses; otherwise the raw string. */
	data: unknown
	raw: string
}

/** Split a complete SSE body into frames. An empty `data` is not dispatched. */
export function parseSse(text: string): SseEvent[] {
	const events: SseEvent[] = []
	let event = "message"
	const dataLines: string[] = []

	const flush = (): void => {
		if (dataLines.length === 0) {
			event = "message"
			return
		}
		const raw = dataLines.join("\n")
		dataLines.length = 0
		const name = event
		event = "message"
		events.push({ data: parseData(raw), event: name, raw })
	}

	for (const line of text.split(/\r?\n/)) {
		if (line === "") {
			flush()
			continue
		}
		if (line.startsWith(":")) continue
		const colon = line.indexOf(":")
		const field = colon < 0 ? line : line.slice(0, colon)
		let value = colon < 0 ? "" : line.slice(colon + 1)
		if (value.startsWith(" ")) value = value.slice(1)
		if (field === "event") event = value
		else if (field === "data") dataLines.push(value)
	}
	flush()
	return events
}

/** SSE text when the body is a string that carries `event:` / `data:` frames. */
export function sseEvents(body: unknown): SseEvent[] | null {
	if (typeof body !== "string") return null
	if (!/^(?:event|data):/m.test(body)) return null
	return parseSse(body)
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
