/** A handler behind a socket: Node's HTTP server on a local port, translating each request and answer. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { type ReferenceRequest, type ReferenceResponse, referenceRequest } from "./wire.ts"

/** Answers one request; a refusal or failure is an answer too. */
export type Handle = (request: ReferenceRequest) => Promise<ReferenceResponse>

export interface Listening {
	server: Server
	/** `http://127.0.0.1:<port>`. */
	origin: string
	/** Drops every connection, then stops listening. */
	close: () => Promise<void>
}

/** Serves `handle` on 127.0.0.1, on a port the system picks. `create` is Node's, unless a test brings its own. */
export async function listen(handle: Handle, create: typeof createServer = createServer): Promise<Listening> {
	const server = create((req, res) => void answer(handle, req, res))
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as AddressInfo
	return {
		/*
		 * `server.close()` only fires once every socket is gone, and oat's client keeps connections
		 * alive — so gating teardown on that callback never let it finish. Connections are dropped
		 * explicitly first.
		 */
		close: async () => {
			server.closeAllConnections()
			await new Promise<void>((done) => server.close(() => done()))
		},
		origin: `http://127.0.0.1:${port}`,
		server,
	}
}

async function answer(handle: Handle, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const headers: Record<string, string> = {}
	for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers[name] = value
	const url = new URL(req.url ?? "/", "http://localhost")
	const response = await handle(referenceRequest(req.method ?? "GET", url, { headers, read: () => readText(req) }))
	res.writeHead(response.status, response.headers)
	res.end(response.body)
}

async function readText(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	return Buffer.concat(chunks).toString("utf8")
}
