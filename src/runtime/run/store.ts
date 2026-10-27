/*
 * One credential store per run, and the ports it is lent: login and refresh steps run through the
 * step engine as nobody, a mint or revoke calls its operation through the primary client as the
 * principal sending the `with` scheme, an OAuth 2 grant posts its form as nobody, and
 * `hooks.resolveCredential` answers a `{ hook: true }` recipe. A minted key's record is judged gone
 * from the primary client's transcript, or read back through it. An identity value a recipe sends
 * registers on the run's redactor. The document's `x-fresh-principal` operation is the store's
 * signup, which a login without a refresh never re-runs. The ports send through the run's clients,
 * which are built over the store, so they reach them only once the run is connected.
 */

import type { Client } from "../../client/client.ts"
import type { CredentialPorts, Hop, StepAnswer } from "../../credentials/ports.ts"
import { type OriginSchemes, recipeSchemes } from "../../credentials/origin-recipes.ts"
import { createStore, type CredentialStore } from "../../credentials/store.ts"
import { signupOf } from "../../credentials/signup.ts"
import { isNetworkError } from "../../errors/network.ts"
import type { Redactor } from "../../security/redact.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import { fillPath } from "../fill-path.ts"
import { resolveBackoff } from "../poll.ts"
import { answerOf } from "../steps/engine.ts"
import type { OriginClient } from "../steps/request.ts"
import { stepRunner } from "../steps/runner.ts"
import type { Loaded, LoadedOrigin } from "./context.ts"
import { credentialRecords } from "./credential-records.ts"
import { boundOf } from "./identity.ts"
import type { RunNetwork } from "./network.ts"

/** The run's clients, once connected. */
export interface RunClients {
	client: Client
	origins: ReadonlyMap<string, OriginClient>
}

export interface StoreWiring {
	network: RunNetwork
	/** The run's, which every client scrubs with. */
	redactor: Pick<Redactor, "registerSecret">
	/** Called only when a port sends, which is after the run is connected. */
	clients: () => RunClients
}

/** Each secondary origin's mapping and the schemes of its document as the run loaded it, in config order. */
export function originSchemes(loaded: Pick<Loaded, "options" | "origins">): OriginSchemes[] {
	/* Load read and modeled every declared origin. */
	return (loaded.options.origins ?? []).map((origin) => ({
		mapping: origin.security,
		schemes: (loaded.origins.get(origin.id) as LoadedOrigin).model.schemes,
	}))
}

/** The run's store: its own, or the primary run's when this run is a secondary origin's. */
export function runStore(loaded: Loaded, wiring: StoreWiring): CredentialStore {
	const { options, model } = loaded
	if (options.sharedCredentials !== undefined) return options.sharedCredentials.store
	const store: CredentialStore = createStore({
		ports: runPorts(loaded, { ...wiring, scopeOf: (principal) => boundOf(store.identityOf(principal)).scope }),
		principals: options.principals,
		/* A recipe only an origin's scheme uses is acquired by that scheme. */
		schemes: recipeSchemes(model.schemes, originSchemes(loaded)),
		security: options.security ?? {},
		...signupOf(model),
	})
	return store
}

/* What an OAuth 2 token answer holds (RFC 6749 §5.1), a rotated refresh token included. */
const OAUTH2_TOKENS: readonly string[] = ["$.access_token", "$.refresh_token", "$.id_token"]

interface PortWiring extends StoreWiring {
	/** The parameters bound for a principal: its config scope and what its login's claims bound. */
	scopeOf: (principal: string) => Readonly<Record<string, string>>
}

function runPorts(loaded: Loaded, wiring: PortWiring): CredentialPorts {
	const { hooks, model, options } = loaded
	/* Every credential an answer holds is a secret before the answer is recorded. */
	const auth = (secrets: readonly string[] = []): Client =>
		wiring.clients().client.view({
			issuedBy: "credentials",
			purpose: "auth",
			...(secrets.length === 0 ? {} : { secrets }),
		})
	const noted = <T>(work: () => Promise<T>): Promise<T> => noteOutage(wiring.network, work)
	return {
		operations: {
			call: (input) =>
				noted(async () => {
					/* Validation refuses a recipe naming an operation the document lacks. */
					const op = model.byOperationId.get(input.operationId) as OperationModel
					const path = fillPath(op.path, { ...wiring.scopeOf(input.as.principal), ...input.scope })
					const body = input.body === undefined ? {} : { body: input.body }
					/* A value of its own is the one session a revoke ends: sent as the principal's, exactly that value. */
					const as = input.value === undefined ? input.as : { ...input.as, value: input.value }
					const sent = { as, operationId: op.operationId, ...body }
					return answerOf(await auth(input.secrets).request(op.method, path, sent))
				}),
		},
		steps: {
			run: (steps, { secrets, ...at }) =>
				noted(() => {
					const { origins } = wiring.clients()
					const shared = { client: auth(secrets), hooks, model, outOfBand: resolveBackoff(options.outOfBand) }
					return stepRunner({ ...shared, originClients: origins }).run(steps, at)
				}),
		},
		records: credentialRecords({ client: () => wiring.clients().client, model, scopeOf: wiring.scopeOf }),
		secrets: { register: (value) => wiring.redactor.registerSecret(value) },
		tokens: {
			post: (url, form, hop) => noted(() => postForm(auth(OAUTH2_TOKENS), { form, url, ...hop })),
		},
		...(hooks.resolveCredential === undefined ? {} : { resolveCredential: hooks.resolveCredential }),
	}
}

async function postForm(
	client: Client,
	post: { url: string; form: Readonly<Record<string, string>> } & Hop,
): Promise<StepAnswer> {
	const exchange = await client.request("POST", post.url, {
		as: { anonymous: true },
		body: new URLSearchParams(post.form),
		contentType: "application/x-www-form-urlencoded",
		/* A real exchange of the token URL, labeled a probe only when it is meant to be refused. */
		...(post.probe ? { probe: post.probe } : {}),
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
