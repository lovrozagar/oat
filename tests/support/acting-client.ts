import { Client } from "../../src/client/client.ts"
import { createCredentialSource } from "../../src/client/credentials.ts"
import type { Hooks } from "../../src/config/types/hooks.ts"
import type { PrincipalsConfig, SecurityConfig } from "../../src/config/types/security.ts"
import type { CredentialPorts } from "../../src/credentials/ports.ts"
import { createStore } from "../../src/credentials/store.ts"
import { stepRunner } from "../../src/runtime/steps/runner.ts"
import { operationResolver } from "../../src/spec/graph/resolver.ts"
import type { SpecModel } from "../../src/spec/graph/types.ts"
import { Redactor } from "../../src/security/redact.ts"

/*
 * A client whose requests act as principals through a real credential store, the way a run's do:
 * each request's credential comes from the operation's security and the principal's recipe. Login
 * and refresh steps run through the client itself; no recipe here mints or posts a token form.
 */

export interface ActingSetup {
	baseUrl: string
	model: SpecModel
	security: SecurityConfig
	principals: PrincipalsConfig
	/** Epoch ms now, for a test that lapses a credential. Default: the system clock. */
	now?: () => number
	/** What sign-in steps call, such as `resolveOutOfBand`. */
	hooks?: Hooks
}

function unused(): never {
	throw new Error("these recipes call no operation and post no token form")
}

/** A client on `baseUrl` acting as the principals of `setup`, over a store holding its recipes. */
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
		baseUrl: setup.baseUrl,
		credentials: createCredentialSource({ model, principals, security, store }),
		operationResolver: operationResolver(model),
		redactor: new Redactor(),
	})
	holder.client = client
	return client
}
