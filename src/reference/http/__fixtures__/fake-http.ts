/** A stand-in for Node's `createServer`: no socket, and every request handed to its listener by hand. */

import type { createServer, IncomingMessage, ServerResponse } from "node:http"

export type Listener = (req: IncomingMessage, res: ServerResponse) => void

export interface FakeServer {
	listener: Listener
	/** Where it was told to listen, once it was. */
	bound: { host: string; port: number } | null
	/** What happened to it, in order: `closeAllConnections`, then `close`. */
	calls: string[]
}

export interface Incoming {
	method?: string
	url?: string
	headers?: Record<string, string | string[]>
	chunks?: readonly string[]
}

export interface Served {
	status: number
	headers: Record<string, string>
	body: string
}

/** A `createServer` whose servers bind nothing; each one it makes is pushed onto `servers`. */
export function fakeCreate(servers: FakeServer[] = [], port = 4321): typeof createServer {
	const create = (listener: Listener) => {
		const made: FakeServer = { bound: null, calls: [], listener }
		servers.push(made)
		return {
			address: () => ({ address: "127.0.0.1", family: "IPv4", port }),
			close: (done: () => void) => {
				made.calls.push("close")
				done()
			},
			closeAllConnections: () => {
				made.calls.push("closeAllConnections")
			},
			listen: (at: number, host: string, ready: () => void) => {
				made.bound = { host, port: at }
				ready()
			},
		}
	}
	return create as unknown as typeof createServer
}

/** Hands `incoming` to the listener and resolves with what it wrote back. */
export function serve(listener: Listener, incoming: Incoming): Promise<Served> {
	const chunks = incoming.chunks ?? []
	const req = {
		headers: incoming.headers ?? {},
		method: incoming.method,
		url: incoming.url,
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield Buffer.from(chunk)
		},
	}
	return new Promise((resolve) => {
		let head: { status: number; headers: Record<string, string> } = { headers: {}, status: 0 }
		const res = {
			end: (body: string) => resolve({ ...head, body }),
			writeHead: (status: number, headers: Record<string, string>) => {
				head = { headers, status }
			},
		}
		listener(req as unknown as IncomingMessage, res as unknown as ServerResponse)
	})
}
