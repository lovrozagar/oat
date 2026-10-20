import { randomBytes } from "node:crypto"
import { createCredentialSource } from "../../client/credentials.ts"
import { operationResolver } from "../../spec/graph/resolver.ts"
import { Redactor } from "../../security/redact.ts"
import { Client } from "../../client/client.ts"
import type { Exchange } from "../exchange.ts"
import { createExchangeJournal, type ExchangeJournal } from "../exchanges/journal.ts"
import { resolveBackoff } from "../poll.ts"
import { buildRateLimitRules } from "../rate-limit/rules.ts"
import { RateLimiter } from "../rate-limit/limiter.ts"
import { Ledger } from "../teardown/ledger.ts"
import { SchemaValidator } from "../validate.ts"
import type { Connected, Loaded } from "./context.ts"
import { createRunNetwork } from "./network.ts"
import { loadOriginClients } from "./origins.ts"
import type { RunProgress } from "./progress.ts"
import { runStore } from "./store.ts"

/**
 * The run's client, and what watches it: one redactor every client, the journal and the report
 * scrub with, the exchange journal, the network gate, the run's credential store, and the clients of
 * the secondary origins, each resolving its actors over that store against its own document.
 */
export function connect(loaded: Loaded): Connected {
	const { options, hooks, model, fence, progress } = loaded
	const redactor = new Redactor()
	for (const name of options.redact?.headers ?? []) redactor.registerHeader(name)
	const journal = options.exchangeDir === undefined ? null : createExchangeJournal(options.exchangeDir, redactor)
	const onExchange = answered(journal, progress)
	const network = createRunNetwork(loaded)
	/* The ports reach the clients only when they send, by which time both exist. */
	const store = runStore(loaded, { clients: () => ({ client, origins: originClients }), network })
	const mapping = options.sharedCredentials?.mapping
	const client = new Client({
		baseUrl: options.baseUrl,
		credentials: createCredentialSource({
			model,
			principals: store.principals,
			security: options.security ?? {},
			store,
			...(mapping === undefined ? {} : { mapping }),
		}),
		fence,
		headers: options.globalHeaders ?? {},
		httpHooks: progress.httpHooks,
		maxInFlight: options.maxInFlight ?? 4,
		network: network.client,
		onExchange,
		operationResolver: operationResolver(model),
		rateLimiter: new RateLimiter(
			buildRateLimitRules(model, options.rateLimits),
			options.maxRps === undefined ? {} : { maxRps: options.maxRps },
		),
		redactor,
		resolveHeaders: hooks.resolveHeaders,
	})
	progress.countRequests(() => client.transcript.length)
	const originClients = loadOriginClients(loaded, { network: network.client, onExchange, redactor, store })
	return {
		...loaded,
		client,
		journal,
		ledger: new Ledger(),
		network,
		nonce: options.nonce ?? randomBytes(4).toString("hex"),
		originClients,
		outOfBand: resolveBackoff(options.outOfBand),
		seed: options.seed ?? 1,
		store,
		validator: new SchemaValidator(model.defs),
	}
}

/** Each answer, journaled under its own check and entity, then shown as the last one. */
function answered(journal: ExchangeJournal | null, progress: RunProgress): (exchange: Exchange) => Promise<void> {
	return async (exchange) => {
		progress.remember(exchange)
		if (journal !== null) {
			try {
				/* The exchange names its own check and entity: a shared "current check" was wrong
				 * whenever checks ran concurrently, and journaled a whole batch under the last one. */
				await journal.record(exchange, {
					...(exchange.check === undefined ? {} : { check: exchange.check }),
					...(exchange.subject === undefined ? {} : { entity: exchange.subject }),
					phase: progress.phase,
				})
			} catch {
				/* journal is observability — a write error must not fail the request */
			}
		}
		progress.announce()
	}
}
