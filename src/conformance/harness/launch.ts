/** How a self-test reaches what it runs oat against: behind a socket, or in process. */

import type { createServer } from "node:http"
import type { DefectSet } from "../../reference/defects/defect-set.ts"
import { d1Store, memoryStore, postgresStore, sqliteStore } from "../../reference/http/engines.ts"
import { asFetch } from "../../reference/http/fetch.ts"
import { type Handle, listen } from "../../reference/http/node.ts"
import { createReference, type StoreFactory } from "../../reference/http/reference.ts"
import { createReferenceServer } from "../../reference/http/server.ts"
import type { ReferenceOptions } from "../../reference/http/state.ts"
import type { Row } from "../../reference/store-api.ts"
import type { Backend } from "../matrix/engines.ts"

/** Something oat can be pointed at, and how to stop it. */
export interface Hosted {
	url: string
	/** The transport to reach it by, when it has no socket; the global `fetch` otherwise. */
	fetch?: typeof fetch | undefined
	close: () => Promise<void>
}

/** A reference backend a self-test runs oat against, and what it can say about its own state. */
export interface Launched extends Hosted {
	defects: DefectSet
	snapshot: () => Promise<Record<string, Row[]>>
	createdIds: () => Record<string, string[]>
}

/** One way to reach things: the reference on an engine, or any handler a suite brings. */
export interface Via {
	launch: (backend: Backend, options: ReferenceOptions) => Promise<Launched>
	host: (handle: Handle) => Promise<Hosted>
}

/** What a self-test runs against: an engine, a dialect, a shape, and how the reference is reached. */
export interface Target {
	backend: Backend
	dialect: string
	shape?: string | undefined
	via: Via
}

/** The store each engine's reference runs on. D1 reads its credentials now, and refuses without them. */
export function storeFor(backend: Backend): StoreFactory {
	if (backend === "memory") return memoryStore
	if (backend === "sqlite") return sqliteStore
	if (backend === "d1") return d1Store()
	return postgresStore
}

/** Behind a socket on a local port. `create` is Node's `createServer`, unless a test brings its own. */
export function listeningVia(create?: typeof createServer): Via {
	return {
		host: async (handle) => {
			const { close, origin } = await listen(handle, create)
			return { close, url: origin }
		},
		launch: async (backend, options) => createReferenceServer(options, storeFor(backend), create),
	}
}

/** Behind a socket: what the conformance gate runs against, so it tests the real transport. */
export const listening: Via = /* @__PURE__ */ listeningVia()

/** In process, reached through the handler itself: no socket, the same answers. */
export const inProcess: Via = {
	host: async (handle) => ({ close: async () => {}, fetch: asFetch(handle), url: "http://hosted.test" }),
	launch: async (backend, options) => createReference(options, storeFor(backend)),
}

/** Launches `target`'s reference with `options`. */
export function launch(target: Target, options: ReferenceOptions): Promise<Launched> {
	return target.via.launch(target.backend, {
		dialect: target.dialect,
		...(target.shape === undefined ? {} : { shape: target.shape }),
		...options,
	})
}

/** The run options that reach what is hosted: its transport, when it has one of its own. */
export function reach(hosted: Hosted): { network?: { fetch: typeof fetch } } {
	return hosted.fetch === undefined ? {} : { network: { fetch: hosted.fetch } }
}
