import type { OatConfig } from "../../config/types/config.ts"
import { UsageError } from "../../errors/usage-error.ts"
import { fetchSpecText } from "../../runtime/network.ts"
import { probeCreateFixtures } from "../../runtime/world.ts"
import { applyGrammarOverrides } from "../../spec/grammar-overrides.ts"
import { buildModel, type SpecModel } from "../../spec/graph.ts"
import { dereference, loadSpec } from "../../spec/load.ts"
import { prepareDocument } from "../../spec/prepare.ts"
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
	const raw = await loadSpec(source, {
		baseUrl: str(flags, "base-url") ?? config?.baseUrl,
		fetchText: fetchSpecText,
	})
	let removed: string[] = []
	try {
		const { doc, externalRefs } = dereference(prepareDocument(raw, config ?? {}, (ids) => (removed = ids)))
		const model = buildModel(doc)
		if (config !== undefined) applyGrammarOverrides(model, config)
		/* A create whose fixtures cannot be built is recorded on the model as a gap. */
		probeCreateFixtures(model)
		return { config, configPath, externalRefs, model, removed }
	} catch (error) {
		if (!(error instanceof UsageError)) throw error
		writer.err(`${error.message}\n`)
		return EXIT.usage
	}
}
