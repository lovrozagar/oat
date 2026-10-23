import { Client } from "../../client/client.ts"
import { createCredentialSource } from "../../client/credentials.ts"
import type { Hooks } from "../../config/types/hooks.ts"
import type { PrincipalsConfig, SecurityConfig } from "../../config/types/security.ts"
import type { CredentialPorts } from "../../credentials/ports.ts"
import { createStore } from "../../credentials/store.ts"
import { Redactor } from "../../security/redact.ts"
import { operationResolver } from "../../spec/graph/resolver.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { stepRunner } from "../steps/runner.ts"

/*
 * A client whose requests act as principals through a real credential store, the way a run's do:
 * each request's credential comes from the operation's security and the principal's recipe. Login
 * and refresh steps run through the client itself; no recipe here mints or posts a token form.
 */

export const ACTING_BASE = "http://api.test"

export interface ActingSetup {
	model: SpecModel
	security: SecurityConfig
	principals: PrincipalsConfig
	/** Default {@link ACTING_BASE}, for a scripted transport. */
	baseUrl?: string
	/** A scripted transport. Default: the network. */
	fetchImpl?: typeof fetch
	/** Epoch ms now, for a test that lapses a credential. Default: the system clock. */
	now?: () => number
	/** What sign-in steps call, such as `resolveOutOfBand`. */
	hooks?: Hooks
}

function unused(): never {
	throw new Error("these recipes call no operation and post no token form")
}

/** A client acting as the principals of `setup`, over a store holding its recipes. */
export function actingClient(setup: ActingSetup): Client {
	const { model, principals, security } = setup
	const holder: { client?: Client } = {}
	const ports: CredentialPorts = {
		operations: { call: unused },
		steps: {
			run: (steps, at) =>
				stepRunner({ client: holder.client as Client, hooks: setup.hooks ?? {}, model }).run(steps, at),
		},
		secrets: { register: () => undefined },
		tokens: { post: unused },
	}
	const store = createStore({
		ports,
		principals,
		schemes: model.schemes,
		security,
		...(setup.now === undefined ? {} : { now: setup.now }),
	})
	const client = new Client({
		baseUrl: setup.baseUrl ?? ACTING_BASE,
		credentials: createCredentialSource({ model, principals, security, store }),
		...(setup.fetchImpl === undefined ? {} : { network: { fetchImpl: setup.fetchImpl } }),
		operationResolver: operationResolver(model),
		redactor: new Redactor(),
	})
	holder.client = client
	return client
}
