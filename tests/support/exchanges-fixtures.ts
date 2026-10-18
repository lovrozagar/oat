import { mkdtemp, readFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Exchange } from "../../src/runtime/exchange.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/* Shared by the exchanges*.test.ts files: exchange rows, scratch dirs, saved files, a widget world. */

export function exchange(partial: Partial<Exchange> = {}): Exchange {
	return {
		at: 1_700_000_000_000,
		durationMs: 12,
		method: "GET",
		requestBody: undefined,
		requestBytes: 10,
		requestHeaders: {},
		requestId: "",
		responseBody: null,
		responseBytes: 20,
		responseHeaders: {},
		seq: 1,
		status: 200,
		url: "http://x.test/v1/things",
		...partial,
	}
}

export async function scratch(): Promise<string> {
	return mkdtemp(join(tmpdir(), "oat-ex-"))
}

/** The parsed JSON file the journal wrote under `<dir>/<path>`. */
export async function readSaved<T>(dir: string, path: string): Promise<T> {
	return JSON.parse(await readFile(join(dir, path), "utf8")) as T
}

/** Starts `handler` on a loopback port; `close` stops it. */
export async function listen(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ close: () => Promise<void>; url: string }> {
	const server = createServer(handler)
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})
	const addr = server.address()
	if (addr === null || typeof addr === "string") throw new Error("no addr")
	return {
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
		url: `http://127.0.0.1:${addr.port}`,
	}
}

const WIDGET = { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" }
const WIDGET_ID = { in: "path", name: "widget_id", required: true, schema: { type: "string" } }

function jsonContent(schema: unknown): Record<string, unknown> {
	return { "application/json": { schema } }
}

function widgetCollection(): Record<string, unknown> {
	return {
		get: {
			operationId: "widget.list",
			responses: {
				"200": {
					content: jsonContent({ properties: { widgets: { items: WIDGET, type: "array" } }, type: "object" }),
					description: "ok",
				},
			},
			"x-entity": { action: "list", identity: "id", name: "widget" },
		},
		post: {
			operationId: "widget.create",
			requestBody: {
				content: jsonContent({ properties: { name: { type: "string" } }, required: ["name"], type: "object" }),
				required: true,
			},
			responses: { "201": { content: jsonContent(WIDGET), description: "created" } },
			"x-entity": { action: "create", identity: "id", name: "widget" },
		},
	}
}

function widgetItem(): Record<string, unknown> {
	return {
		delete: {
			operationId: "widget.delete",
			parameters: [WIDGET_ID],
			responses: { "204": { description: "gone" } },
			"x-entity": { action: "delete", identity: "id", name: "widget" },
		},
		get: {
			operationId: "widget.read",
			parameters: [WIDGET_ID],
			responses: { "200": { content: jsonContent(WIDGET), description: "ok" } },
			"x-entity": { action: "read", identity: "id", name: "widget" },
		},
	}
}

/** A widget entity with list, create, read and delete. */
export function widgetSpec(): OpenApiDocument {
	return {
		info: { title: "j", version: "1" },
		openapi: "3.1.0",
		paths: { "/v1/widgets": widgetCollection(), "/v1/widgets/{widget_id}": widgetItem() },
	} as OpenApiDocument
}

type Widget = { id: string; name: string }
type Write = (status: number, body?: unknown) => void

/** An in-memory widget store; `seq` numbers both the ids and the x-request-id. */
export class WidgetWorld {
	readonly #widgets = new Map<string, Widget>()
	#seq = 0
	readonly #spec = widgetSpec()

	handle(req: IncomingMessage, res: ServerResponse): void {
		const write = this.#writer(res)
		this.#route(req, write).catch(() => {
			res.writeHead(500)
			res.end()
		})
	}

	#writer(res: ServerResponse): Write {
		return (status, body) => {
			if (body === undefined) {
				res.writeHead(status)
				res.end()
				return
			}
			const text = JSON.stringify(body)
			res.writeHead(status, {
				"content-length": String(Buffer.byteLength(text)),
				"content-type": "application/json",
				"x-request-id": `wid-${String(this.#seq + 1)}`,
			})
			res.end(text)
		}
	}

	async #route(req: IncomingMessage, write: Write): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const method = (req.method ?? "GET").toUpperCase()
		if (url.pathname === "/v1/openapi/spec") return write(200, this.#spec)
		if (url.pathname === "/v1/widgets" && method === "GET") return write(200, { widgets: [...this.#widgets.values()] })
		if (url.pathname === "/v1/widgets" && method === "POST") return write(201, await this.#create(req))
		const item = /^\/v1\/widgets\/([^/]+)$/.exec(url.pathname)
		if (item === null) return write(404)
		return this.#item(method, item[1] ?? "", write)
	}

	async #create(req: IncomingMessage): Promise<Widget> {
		const chunks: Buffer[] = []
		for await (const chunk of req) chunks.push(chunk as Buffer)
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { name?: string }
		const id = `w_${String((this.#seq += 1))}`
		const row = { id, name: body.name ?? "n" }
		this.#widgets.set(id, row)
		return row
	}

	#item(method: string, id: string, write: Write): void {
		if (method === "GET") {
			const row = this.#widgets.get(id)
			return row === undefined ? write(404) : write(200, row)
		}
		if (method === "DELETE") {
			this.#widgets.delete(id)
			return write(204)
		}
		return write(404)
	}
}
