/*
 * One credential store per run, and the ports it is lent: login and refresh steps run through the
 * step engine as nobody, a mint or revoke calls its operation through the primary client as the
 * principal sending the `with` scheme, an OAuth 2 grant posts its form as nobody, and
 * `hooks.resolveCredential` answers a `{ hook: true }` recipe. The document's `x-fresh-principal`
 * operation is the store's signup, which a login without a refresh never re-runs. The ports send through the run's
 * clients, which are built over the store, so they reach them only once the run is connected.
 */

import type { Client } from "../../client/client.ts"
import type { CredentialPorts, StepAnswer } from "../../credentials/ports.ts"
import { createStore, type CredentialStore } from "../../credentials/store.ts"
import { signupOf } from "../../credentials/signup.ts"
import { isNetworkError } from "../../errors/network.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import { fillPath } from "../fill-path.ts"
import { resolveBackoff } from "../poll.ts"
import { answerOf } from "../steps/engine.ts"
import type { OriginClient } from "../steps/request.ts"
import { stepRunner } from "../steps/runner.ts"
import type { Loaded } from "./context.ts"
import { boundOf } from "./identity.ts"
import type { RunNetwork } from "./network.ts"

/** The run's clients, once connected. */
export interface RunClients {
	client: Client
	origins: ReadonlyMap<string, OriginClient>
}

export interface StoreWiring {
	network: RunNetwork
	/** Called only when a port sends, which is after the run is connected. */
	clients: () => RunClients
}

/** The run's store: its own, or the primary run's when this run is a secondary origin's. */
export function runStore(loaded: Loaded, wiring: StoreWiring): CredentialStore {
	const { options, model } = loaded
	if (options.sharedCredentials !== undefined) return options.sharedCredentials.store
	const store: CredentialStore = createStore({
		ports: runPorts(loaded, { ...wiring, scopeOf: (principal) => boundOf(store.identityOf(principal)).scope }),
		principals: options.principals,
		schemes: model.schemes,
		security: options.security ?? {},
		...signupOf(model),
	})
	return store
}

interface PortWiring extends StoreWiring {
	/** The parameters bound for a principal: its config scope and what its login's claims bound. */
	scopeOf: (principal: string) => Readonly<Record<string, string>>
}

function runPorts(loaded: Loaded, wiring: PortWiring): CredentialPorts {
	const { hooks, model, options } = loaded
	const auth = (): Client => wiring.clients().client.view({ purpose: "auth" })
	const noted = <T>(work: () => Promise<T>): Promise<T> => noteOutage(wiring.network, work)
	return {
		operations: {
			call: (input) =>
				noted(async () => {
					/* Validation refuses a recipe naming an operation the document lacks. */
					const op = model.byOperationId.get(input.operationId) as OperationModel
					const path = fillPath(op.path, { ...wiring.scopeOf(input.as.principal), ...input.scope })
					const body = input.body === undefined ? {} : { body: input.body }
					return answerOf(await auth().request(op.method, path, { as: input.as, operationId: op.operationId, ...body }))
				}),
		},
		steps: {
			run: (steps, at) =>
				noted(() => {
					const { origins } = wiring.clients()
					const shared = { client: auth(), hooks, model, outOfBand: resolveBackoff(options.outOfBand) }
					return stepRunner({ ...shared, originClients: origins }).run(steps, at)
				}),
		},
		tokens: {
			post: (url, form) => noted(() => postForm(auth(), { form, url })),
		},
		...(hooks.resolveCredential === undefined ? {} : { resolveCredential: hooks.resolveCredential }),
	}
}

async function postForm(
	client: Client,
	post: { url: string; form: Readonly<Record<string, string>> },
): Promise<StepAnswer> {
	const exchange = await client.request("POST", post.url, {
		as: { anonymous: true },
		body: new URLSearchParams(post.form),
		contentType: "application/x-www-form-urlencoded",
		probe: true,
	})
	return answerOf(exchange)
}

/* A login that never got an answer is the network going away, the run's outage, before it is BLOCKED. */
async function noteOutage<T>(network: RunNetwork, work: () => Promise<T>): Promise<T> {
	try {
		return await work()
	} catch (error) {
		if (isNetworkError(error)) await network.note(error, "auth")
		throw error
	}
}
