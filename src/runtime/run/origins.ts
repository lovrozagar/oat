import type { Hooks } from "../../config/types/hooks.ts"
import type { Principal } from "../../config/types/principals.ts"
import { buildModel } from "../../spec/graph/build.ts"
import { dereference } from "../../spec/load/dereference.ts"
import { loadSpec } from "../../spec/load/source.ts"
import { applyOverlay } from "../../spec/overlay.ts"
import type { OriginClient } from "../steps/request.ts"
import { Client } from "../../client/client.ts"
import type { NetworkClientOptions } from "../../client/types.ts"
import type { Exchange } from "../exchange.ts"
import { fetchSpecText } from "../network/fetch.ts"
import { persistedToPrincipal, type PersistedPrincipal } from "../principals.ts"
import type { Redactor } from "../../security/redact.ts"
import { RateLimiter } from "../rate-limit/limiter.ts"
import type { ScopeReport } from "../scope/types.ts"
import type { Loaded, RunContext } from "./context.ts"
import { transportOpt } from "./network.ts"
import type { RunOptions, RunResult } from "./types.ts"

/** How each origin's client reports and recovers: the same as the primary's. */
export interface OriginWiring {
	network: NetworkClientOptions
	onExchange: (exchange: Exchange) => Promise<void>
	/** The primary's: one redactor scrubs every client of the run. */
	redactor: Redactor
}

/** A client per secondary origin, over that origin's own document. */
export async function loadOriginClients(loaded: Loaded, wiring: OriginWiring): Promise<Map<string, OriginClient>> {
	const { options, hooks, progress, fence } = loaded
	const clients = new Map<string, OriginClient>()
	for (const origin of options.origins ?? []) {
		const raw = await loadSpec(origin.spec, {
			baseUrl: origin.baseUrl,
			fetchText: (url) => fetchSpecText(url, transportOpt(options)),
		})
		const { doc } = dereference(origin.overlay === undefined ? raw : applyOverlay(raw, origin.overlay))
		const client = new Client({
			baseUrl: origin.baseUrl,
			fence,
			headers: options.globalHeaders ?? {},
			httpHooks: progress.httpHooks,
			maxInFlight: options.maxInFlight ?? 4,
			network: wiring.network,
			onExchange: wiring.onExchange,
			rateLimiter: origin.maxRps === undefined ? undefined : new RateLimiter([], { maxRps: origin.maxRps }),
			redactor: wiring.redactor,
			resolveHeaders: hooks.resolveHeaders,
		})
		clients.set(origin.id, { client, model: buildModel(doc) })
	}
	return clients
}

/** What a secondary origin's run takes from the primary's options as they are. */
const INHERITED = [
	"uploads",
	"configDir",
	"globalHeaders",
	"roots",
	"seed",
	"cohortSize",
	"profiles",
	"profile",
	"rateLimits",
	"keepFixtures",
	"maxInFlight",
	"outOfBand",
	"onProgress",
	"query",
	"entities",
	"exchangeDir",
	"network",
] as const satisfies ReadonlyArray<keyof RunOptions>

/** What the secondary runs found, folded into this run's result. */
export interface OriginRuns {
	persisted: PersistedPrincipal[]
	coverage: ScopeReport
	/** Runs one origin: `run` itself, passed in so this stage does not import the pipeline. */
	runOrigin: (options: RunOptions) => Promise<RunResult>
}

/**
 * Each secondary origin as a run of its own, with the primary's principals as they stood after
 * acquire. Its findings and coverage join this run's, named by origin.
 */
export async function runSecondaryOrigins(ctx: RunContext, runs: OriginRuns): Promise<void> {
	const { options, scope } = ctx
	for (const origin of options.origins ?? []) {
		/* Targets were resolved against every origin up front; an origin none of them name has
		 * nothing to grade, and running it anyway is the cost --ops exists to skip. */
		const originOps = scope.origins.get(origin.id)
		if (scope.mode === "targeted" && originOps === undefined) {
			runs.coverage.originsSkipped.push(origin.id)
			continue
		}
		const result = await runs.runOrigin({
			...inherited(options),
			baseUrl: origin.baseUrl,
			principals: runs.persisted.map(persistedToPrincipal) as [Principal, ...Principal[]],
			scenarios: (options.scenarios ?? [])
				.filter((scenario) => scenario.origin === origin.id)
				.map(({ origin: _origin, ...scenario }) => scenario),
			skipPrincipalTeardown: true,
			spec: origin.spec,
			...originHooks(options.hooks),
			...(originOps === undefined ? {} : { ops: originOps }),
			...(origin.maxRps === undefined ? {} : { maxRps: origin.maxRps }),
		})
		absorb(ctx, origin.id, result, runs.coverage)
	}
}

function inherited(options: RunOptions): Partial<RunOptions> {
	const picked: Record<string, unknown> = {}
	for (const key of INHERITED) {
		if (options[key] !== undefined) picked[key] = options[key]
	}
	return picked as Partial<RunOptions>
}

/* The principals are the primary's, and the primary removes them. */
function originHooks(hooks: Hooks | undefined): { hooks?: Hooks } {
	if (hooks === undefined) return {}
	const { teardownPrincipal: _removed, ...rest } = hooks
	return { hooks: rest }
}

function absorb(ctx: RunContext, id: string, result: RunResult, coverage: ScopeReport): void {
	const { findings, state } = ctx
	const named = <T extends { entity: string }>(item: T): T => ({ ...item, entity: `${id}:${item.entity}` })
	for (const finding of result.findings) findings.report({ ...finding, origin: id })
	for (const check of result.checksRun) state.checksRun.add(check)
	state.checksSkipped.push(...result.checksSkipped.map(named))
	state.checksSuppressed.push(...result.checksSuppressed.map(named))
	for (const entity of result.entitiesTested) state.entitiesTested.push(`${id}:${entity}`)
	state.checksOutOfScope.push(...result.checksOutOfScope.map(named))
	for (const op of result.scope.operations) coverage.operations.push({ ...op, origin: id })
	for (const use of result.scope.support) coverage.support.push({ ...use, origin: id })
	for (const item of result.inconclusive) findings.unresolved(item.check, `${id}:${item.entity}`, item.reason)
}
