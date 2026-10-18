import { applyGrammarOverrides } from "../../spec/grammar-overrides.ts"
import { buildModel } from "../../spec/graph/build.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { dereference } from "../../spec/load/dereference.ts"
import { loadSpec } from "../../spec/load/source.ts"
import { prepareDocument } from "../../spec/prepare.ts"
import { Fence } from "../fence.ts"
import { FindingCollector, isRootCause } from "../finding.ts"
import { fetchSpecText, type NetworkFetchOptions } from "../network/fetch.ts"
import { resolveProfile } from "../profile.ts"
import { probeCreateFixtures } from "../world/probe-fixtures.ts"
import type { Loaded } from "./context.ts"
import { requestTimeoutOpt, transportOpt } from "./network.ts"
import { RunProgress } from "./progress.ts"
import { emptyState } from "./state.ts"
import type { RunOptions } from "./types.ts"

/** Reads the document — the first request of the run when it is served — and models it. */
export async function load(options: RunOptions): Promise<Loaded> {
	/* An unknown profile is a config error: it costs nothing to find out. */
	const profile = resolveProfile(options.profile, options.profiles)
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
		fetchText: (url) => fetchSpecText(url, network),
	})
	return {
		fence,
		findings,
		hooks: options.hooks ?? {},
		model: modelOf(raw, options),
		options,
		profile,
		progress,
		state: emptyState(),
	}
}

function modelOf(raw: Parameters<typeof prepareDocument>[0], options: RunOptions): SpecModel {
	const { doc } = dereference(prepareDocument(raw, options))
	const model = buildModel(doc)
	applyGrammarOverrides(model, options)
	/* A create whose fixtures cannot be built is recorded on the model as a gap, before any request. */
	probeCreateFixtures(model)
	return model
}
