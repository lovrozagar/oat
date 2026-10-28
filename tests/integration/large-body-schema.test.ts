import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A listing page larger than the transcript keeps in memory is held to its schema all the same: its
 * verdict is taken when it is captured, so a drifted body is reported however large it is.
 */

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

const NOTE = {
	properties: { id: { type: "string" }, size: { type: "integer" }, text: { type: "string" } },
	required: ["id", "size", "text"],
	type: "object",
}

const ok = (schema: unknown) => ({ "200": { content: { "application/json": { schema } }, description: "ok" } })

function spec(): OpenApiDocument {
	return {
		info: { title: "large pages", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/notes": { get: { operationId: "note.list", responses: ok({ items: NOTE, type: "array" }) } },
			"/notes/{noteId}": {
				get: {
					operationId: "note.get",
					parameters: [{ in: "path", name: "noteId", required: true, schema: { type: "string" } }],
					responses: { ...ok(NOTE), "404": { description: "missing" } },
				},
			},
		},
	} as OpenApiDocument
}

/* 400 notes of 1 KiB each, every size answered as text where the document promises an integer. */
const NOTES = Array.from({ length: 400 }, (_, index) => ({ id: `n${index}`, size: "large", text: "x".repeat(1024) }))

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" })
	res.end(JSON.stringify(body))
}

function handle(req: IncomingMessage, res: ServerResponse): void {
	const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname
	if (path === "/openapi.json") return send(res, 200, spec())
	if (path === "/notes") return send(res, 200, NOTES)
	const note = NOTES.find((each) => path === `/notes/${each.id}`)
	return note === undefined ? send(res, 404, {}) : send(res, 200, note)
}

async function serve(): Promise<string> {
	const server = createServer(handle)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("a listing page over the in-memory limit", () => {
	it("is held to its documented schema, and a drifted body reported however large", async () => {
		expect(JSON.stringify(NOTES).length).toBeGreaterThan(256 * 1024)
		const url = await serve()
		const result = await run({
			baseUrl: url,
			ops: ["note.list"],
			principals: { alpha: {} },
			spec: `${url}/openapi.json`,
		})
		const read = result.findings.filter((finding) => finding.check === "schema.read-response-matches-document")
		expect(read).toEqual([expect.objectContaining({ entity: "note", verdict: "SPEC_BUG" })])
		expect(read[0]?.detail).toContain("/0/size must be integer")
		expect(JSON.stringify(result)).not.toContain("over the in-memory limit")
	}, 60_000)
})
