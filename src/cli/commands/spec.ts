import type { OatConfig } from "../../config/types/config.ts"
import { UsageError } from "../../errors/usage-error.ts"
import { fetchSpecText } from "../../runtime/network/fetch.ts"
import { probeCreateFixtures } from "../../runtime/world/probe-fixtures.ts"
import { applyGrammarOverrides } from "../../spec/grammar-overrides.ts"
import { buildModel } from "../../spec/graph/build.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { dereference } from "../../spec/load/dereference.ts"
import { loadSpec } from "../../spec/load/source.ts"
import { prepareDocument } from "../../spec/prepare.ts"
import { assertSecurity } from "../../credentials/validate/security.ts"
import { loadOrigins } from "../../runtime/run/load.ts"
import { readConfig } from "../config.ts"
import { type Args, str, USAGE } from "../flags.ts"
import type { Writer } from "../writer.ts"
import { EXIT } from "../../runtime/exit.ts"

/** The document a command reads, modelled, with what its config said about it. */
export interface Modelled {
	model: SpecModel
	/** `$ref`s to other files, left unresolved. */
	externalRefs: string[]
	/** Operations the config's `allow` list removed from the document. */
	removed: string[]
	config: OatConfig | undefined
	configPath: string | undefined
}

/**
 * The document `--spec` (or the config's) names, modelled offline — or the exit code of a refusal
 * already written. A relative document resolves against the config's base URL, as for `run`.
 */
export async function modelled(writer: Writer, flags: Args["flags"]): Promise<Modelled | number> {
	const configPath = str(flags, "config")
	const read = configPath === undefined ? undefined : await readConfig(configPath, false)
	if (read !== undefined && "problem" in read) {
		writer.err(`oat: ${read.problem}\n`)
		return EXIT.usage
	}
	const config = read?.config
	const source = str(flags, "spec") ?? config?.spec
	if (source === undefined) {
		writer.err(`oat: --spec (or --config) is required\n\n${USAGE}`)
		return EXIT.usage
	}
	let removed: string[] = []
	try {
		const raw = await loadSpec(source, {
			baseUrl: str(flags, "base-url") ?? config?.baseUrl,
			fetchText: fetchSpecText,
		})
		const { doc, externalRefs } = dereference(prepareDocument(raw, config ?? {}, (ids) => (removed = ids)))
		const model = buildModel(doc)
		if (config !== undefined) {
			applyGrammarOverrides(model, config)
			/* The credentials are checked as `run` checks them: against this document and each origin's. */
			assertSecurity({ ...config }, { doc, model }, await loadOrigins(config.origins ?? [], fetchSpecText))
		}
		/* A create whose fixtures cannot be built is recorded on the model as a gap. */
		probeCreateFixtures(model)
		return { config, configPath, externalRefs, model, removed }
	} catch (error) {
		if (!(error instanceof UsageError)) throw error
		writer.err(`${error.message}\n`)
		return EXIT.usage
	}
}
