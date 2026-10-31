import { dirname, resolve } from "node:path"
import type { OatConfig } from "../../config/types/config.ts"
import { UsageError } from "../../errors/usage-error.ts"
import { fetchSpecText } from "../../runtime/network/fetch.ts"
import { probeCreateFixtures } from "../../runtime/world/probe-fixtures.ts"
import { buildConfiguredModel } from "../../spec/configured-model.ts"
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

/** The document a command reads, modeled, with what its config said about it. */
export interface Modeled {
	model: SpecModel
	/** `$ref`s left unresolved: a URL, an anchor, or any ref of a fetched document. */
	externalRefs: string[]
	/** Internal `$ref`s that point at nothing: the model reads each per operation. */
	danglingRefs: string[]
	/** Operations the config's `allow` list removed from the document. */
	removed: string[]
	config: OatConfig | undefined
	configPath: string | undefined
	/** Variables the config names that are not set, read as their `${NAME}` literal. Undefined without a config. */
	unsetEnv: string[] | undefined
}

/* The config an offline command reads, if any: deferred, since nothing is sent. */
interface OfflineConfig {
	config: OatConfig | undefined
	unsetEnv: string[] | undefined
}

/* The config `--config` names, or none, or the exit code of a refusal already written. */
async function offlineConfig(writer: Writer, configPath: string | undefined): Promise<OfflineConfig | number> {
	if (configPath === undefined) return { config: undefined, unsetEnv: undefined }
	const read = await readConfig(configPath, false, { deferEnv: true })
	if ("problem" in read) {
		writer.err(`oat: ${read.problem}\n`)
		return EXIT.usage
	}
	return { config: read.config, unsetEnv: read.unsetEnv }
}

/* The base URL a relative document resolves against. One still holding an unset `${NAME}` is none. */
function baseUrlOf(flags: Args["flags"], { config, unsetEnv = [] }: OfflineConfig): string | undefined {
	const baseUrl = config?.baseUrl
	const unresolved = unsetEnv.some((name) => baseUrl?.includes(`\${${name}}`))
	return str(flags, "base-url") ?? (unresolved ? undefined : baseUrl)
}

/**
 * The document `--spec` (or the config's) names, modeled offline — or the exit code of a refusal
 * already written. A relative document resolves against the config's base URL, as for `run`. Nothing
 * is sent, so a config whose variables are not set yet is read, each listed in `unsetEnv`.
 */
export async function modeled(writer: Writer, flags: Args["flags"]): Promise<Modeled | number> {
	const configPath = str(flags, "config")
	const read = await offlineConfig(writer, configPath)
	if (typeof read === "number") return read
	const { config, unsetEnv } = read
	const flagged = str(flags, "spec")
	const source = flagged ?? config?.spec
	if (source === undefined) {
		writer.err(`oat: --spec (or --config) is required\n\n${USAGE}`)
		return EXIT.usage
	}
	let removed: string[] = []
	try {
		/* A path the config holds is the config's, read from its folder; one on the command line is the shell's. */
		const configDir = configPath === undefined ? undefined : dirname(resolve(configPath))
		const raw = await loadSpec(source, {
			baseUrl: baseUrlOf(flags, read),
			dir: flagged === undefined ? configDir : undefined,
			fetchText: fetchSpecText,
		})
		const { danglingRefs, doc, externalRefs } = dereference(
			prepareDocument(raw, config ?? {}, (ids) => (removed = ids)),
		)
		const model = buildConfiguredModel(doc, config ?? {})
		if (config !== undefined) {
			/* The credentials are checked as `run` checks them: against this document and each origin's. */
			assertSecurity(
				{ ...config },
				{ doc, model },
				await loadOrigins(config.origins ?? [], { dir: configDir, fetchText: fetchSpecText }),
			)
		}
		/* A create whose fixtures cannot be built is recorded on the model as a gap. */
		probeCreateFixtures(model)
		return { config, configPath, danglingRefs, externalRefs, model, removed, unsetEnv }
	} catch (error) {
		if (!(error instanceof UsageError)) throw error
		writer.err(`${error.message}\n`)
		return EXIT.usage
	}
}
