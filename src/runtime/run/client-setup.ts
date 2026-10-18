import { randomBytes } from "node:crypto"
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
import { RunCredentials } from "./credentials.ts"
import { createRunNetwork } from "./network.ts"
import { loadOriginClients } from "./origins.ts"
import type { RunProgress } from "./progress.ts"

/**
 * The run's client, and what watches it: one redactor every client, the journal and the report
 * scrub with, the exchange journal, the network gate, and the clients of the secondary origins.
 */
export async function connect(loaded: Loaded): Promise<Connected> {
	const { options, hooks, model, fence, progress } = loaded
	const redactor = new Redactor()
	const journal = options.exchangeDir === undefined ? null : createExchangeJournal(options.exchangeDir, redactor)
	const onExchange = answered(journal, progress)
	const network = createRunNetwork(loaded)
	const credentials = new RunCredentials()
	const client = new Client({
		baseUrl: options.baseUrl,
		credentials,
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
	if (options.principals[0] === undefined) throw new Error("oat: at least one principal is required")
	const originClients = await loadOriginClients(loaded, { network: network.client, onExchange, redactor })
	return {
		...loaded,
		client,
		credentials,
		journal,
		ledger: new Ledger(),
		network,
		nonce: options.nonce ?? randomBytes(4).toString("hex"),
		originClients,
		outOfBand: resolveBackoff(options.outOfBand),
		seed: options.seed ?? 1,
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
