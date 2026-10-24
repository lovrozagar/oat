/** The reference backend behind a socket: the in-process handler on a local port, for what needs a real URL. */

import type { createServer, Server } from "node:http"
import { listen } from "./node.ts"
import { closeStore, createdIds, type Reference, referenceState, snapshot, type StoreFactory } from "./reference.ts"
import { handle } from "./router.ts"
import { PRINCIPALS, type ReferenceOptions } from "./state.ts"

export interface ReferenceServer extends Omit<Reference, "fetch"> {
	server: Server
}

/** One server, any store: the handler `createReference` runs, listening on 127.0.0.1. */
export async function createReferenceServer(
	options: ReferenceOptions,
	createStore: StoreFactory,
	create?: typeof createServer,
): Promise<ReferenceServer> {
	const state = await referenceState(options, createStore)
	const listening = await listen((request) => handle(state, request), create)
	return {
		/* The store is closed once the socket is, whatever a persistent backend still holds. */
		close: async () => {
			await listening.close()
			await closeStore(state)
		},
		createdIds: () => createdIds(state),
		defects: state.defects,
		issuedTotpSecrets: () => [...state.totpSecrets],
		principals: PRINCIPALS,
		server: listening.server,
		snapshot: () => snapshot(state),
		url: `${listening.origin}${state.basePath}`,
	}
}
