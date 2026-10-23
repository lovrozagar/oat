import { writeFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { UsageError } from "../../errors/usage-error.ts"
import { EXIT } from "../../runtime/exit.ts"
import { fetchSpecText } from "../../runtime/network/fetch.ts"
import { dereference } from "../../spec/load/dereference.ts"
import { loadSpec } from "../../spec/load/source.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { type Args, str, USAGE } from "../flags.ts"
import type { Writer } from "../writer.ts"
import { renderInitConfig } from "./init-config.ts"

/* A config oat can import: one module, never JSON, which cannot call env(). */
const MODULES: ReadonlySet<string> = /* @__PURE__ */ new Set([".ts", ".mts", ".js", ".mjs"])

/**
 * The `spec` a config written to `out` holds: a relative path rebased onto `out`'s folder, which is
 * where a config's relative paths resolve from. A URL and an absolute path stay as given.
 */
export function specFromConfig(spec: string, out: string): string {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec) || isAbsolute(spec)) return spec
	return relative(dirname(resolve(out)), resolve(spec))
		.split(sep)
		.join("/")
}

/**
 * `oat init --spec <url|file> [--out file] [--force]`: writes a starter config from the document's
 * security schemes, and prints the env vars it reads. An existing file is kept unless `--force`.
 */
export async function commandInit(writer: Writer, flags: Args["flags"]): Promise<number> {
	const spec = str(flags, "spec")
	if (spec === undefined) {
		writer.err(`oat: init requires --spec\n\n${USAGE}`)
		return EXIT.usage
	}
	const out = str(flags, "out") ?? "oat.config.ts"
	if (!MODULES.has(extname(out))) {
		writer.err(`oat: init writes a module config (.ts, .mts, .js or .mjs), got ${out}\n`)
		return EXIT.usage
	}
	let doc: OpenApiDocument
	try {
		doc = dereference(await loadSpec(spec, { fetchText: fetchSpecText })).doc
	} catch (error) {
		if (!(error instanceof UsageError)) throw error
		writer.err(`${error.message}\n`)
		return EXIT.usage
	}
	const config = renderInitConfig(doc, { out, spec: specFromConfig(spec, out) })
	try {
		await writeFile(out, config.text, { flag: flags.force === true ? "w" : "wx" })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		writer.err(`oat: ${out} exists; --force overwrites it\n`)
		return EXIT.usage
	}
	const schemes = `${config.schemes} scheme${config.schemes === 1 ? "" : "s"}`
	writer.out(
		[
			`  wrote ${out} — ${schemes}, 1 principal`,
			...(config.env.length === 0 ? [] : [`    set ${config.env.join(", ")}`]),
			...config.unsupported.map(({ name, type, why }) => `    ${name} (${type}) is not sent by oat: ${why}`),
			`    next: oat doctor --config ${out}`,
			"",
		].join("\n"),
	)
	return 0
}
