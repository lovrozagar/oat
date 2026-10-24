import type { OriginSpec } from "../../config/types/config.ts"
import { writerFirst } from "../../credentials/writer.ts"
import { assertSecurity } from "../../credentials/validate/security.ts"
import { applyGrammarOverrides } from "../../spec/grammar-overrides.ts"
import { buildModel } from "../../spec/graph/build.ts"
import { dereference } from "../../spec/load/dereference.ts"
import { loadSpec } from "../../spec/load/source.ts"
import { applyOverlay } from "../../spec/overlay.ts"
import { prepareDocument } from "../../spec/prepare.ts"
import { Fence } from "../fence.ts"
import { FindingCollector, isRootCause } from "../finding.ts"
import { fetchSpecText, type NetworkFetchOptions } from "../network/fetch.ts"
import { resolveProfile } from "../profile.ts"
import { probeCreateFixtures } from "../world/probe-fixtures.ts"
import type { Loaded, LoadedOrigin } from "./context.ts"
import { requestTimeoutOpt, transportOpt } from "./network.ts"
import { RunProgress } from "./progress.ts"
import { assertTranscript } from "./transcript-options.ts"
import { emptyState } from "./state.ts"
import type { RunOptions } from "./types.ts"

/**
 * Reads the document — the first request of the run when it is served — and each origin's, models
 * them, and checks the config's credentials against them: a misfit is a UsageError, nothing sent.
 */
export async function load(options: RunOptions): Promise<Loaded> {
	/* An unknown profile, or a transcript budget or folder the run cannot honor, is a config error: it costs nothing to find out. */
	const profile = resolveProfile(options.profile, options.profiles)
	assertTranscript(options.transcript)
	const findings = new FindingCollector()
	const progress = new RunProgress(options.onProgress, Date.now(), () => findings.findings.filter(isRootCause).length)
	const fence = options.hooks?.beforeRequest === undefined ? undefined : new Fence(options.hooks.beforeRequest)
	progress.tick({ message: options.spec, phase: "load", requests: 0 })
	/* Fetching the document is a request too, when it comes from a server. */
	if (/^https?:\/\//i.test(options.spec)) {
		await fence?.check({ body: undefined, headers: {}, method: "GET", phase: "load", url: options.spec })
	}
	const network: NetworkFetchOptions = {
		onWait: (info) => {
			progress.tick({
				message: `waiting for network (${info.kind}, ${Math.ceil(info.remainingMs / 1000)}s left)`,
				phase: "load",
				requests: 0,
			})
		},
		...(options.network?.retries === undefined ? {} : { retries: options.network.retries }),
		...(options.network?.waitMs === undefined ? {} : { waitMs: options.network.waitMs }),
		...requestTimeoutOpt(options.network?.requestTimeoutMs),
		...transportOpt(options),
	}
	const raw = await loadSpec(options.spec, {
		baseUrl: options.baseUrl,
		dir: options.configDir,
		fetchText: (url) => fetchSpecText(url, network),
	})
	const primary = modelOf(raw, options)
	const origins = await loadOrigins(options.origins ?? [], {
		dir: options.configDir,
		fetchText: (url) => fetchSpecText(url, transportOpt(options)),
	})
	/* A secondary origin's run: the primary checked the config against this document already. */
	if (options.sharedCredentials === undefined) assertSecurity({ ...options }, primary, origins)
	return {
		fence,
		findings,
		hooks: options.hooks ?? {},
		model: primary.model,
		/* Every reader of the principals takes the first as the writer. */
		options: { ...options, principals: writerFirst(options.principals, options.writer) },
		origins,
		profile,
		progress,
		state: emptyState(),
	}
}

function modelOf(raw: Parameters<typeof prepareDocument>[0], options: RunOptions): LoadedOrigin {
	const { doc } = dereference(prepareDocument(raw, options))
	const model = buildModel(doc)
	applyGrammarOverrides(model, options)
	/* A create whose fixtures cannot be built is recorded on the model as a gap, before any request. */
	probeCreateFixtures(model)
	return { doc, model }
}

/**
 * Each secondary origin's document after its overlay, read once and modeled, by origin id. A relative
 * path is read from `dir`, the config's folder.
 */
export async function loadOrigins(
	declared: readonly OriginSpec[],
	source: { fetchText: (url: string) => Promise<string>; dir?: string | undefined },
): Promise<Map<string, LoadedOrigin>> {
	const origins = new Map<string, LoadedOrigin>()
	for (const origin of declared) {
		const raw = await loadSpec(origin.spec, { ...source, baseUrl: origin.baseUrl })
		const { doc } = dereference(origin.overlay === undefined ? raw : applyOverlay(raw, origin.overlay))
		origins.set(origin.id, { doc, model: buildModel(doc) })
	}
	return origins
}
