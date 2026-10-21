import { join, sep } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

/*
 * `bun run check` covers the shipped labs TypeScript through tsconfig.test.json. The labs configs
 * import the build, "../dist/index.js", as a copy inside the repository must; CI checks before
 * anything is built, so `rootDirs` maps that path onto the source. A build that exists is read
 * first whatever the order, so a local check alone cannot prove the mapping: these checks hide the
 * build folder from the compiler, as a fresh clone has none, and type-check labs against the source.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const BUILD = join(ROOT, "dist")
const LABS = join(ROOT, "labs") + sep

function config(): ts.ParsedCommandLine {
	const read = ts.readConfigFile(join(ROOT, "tsconfig.test.json"), ts.sys.readFile)
	return ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT)
}

const hidden = (path: string): boolean => path === BUILD || path.startsWith(BUILD + sep)

/** Each diagnostic in a labs file, as `file(line): TSxxxx`, from a program that cannot see the build. */
function labsErrors(parsed: ts.ParsedCommandLine, options: ts.CompilerOptions): string[] {
	const host = ts.createCompilerHost(options)
	host.fileExists = (path) => !hidden(path) && ts.sys.fileExists(path)
	host.directoryExists = (path) => !hidden(path) && ts.sys.directoryExists(path)
	const rootNames = parsed.fileNames.filter((file) => file.startsWith(LABS))
	const program = ts.createProgram({ host, options, rootNames })
	return ts
		.getPreEmitDiagnostics(program)
		.filter((diagnostic) => diagnostic.file?.fileName.startsWith(LABS) === true)
		.map((diagnostic) => {
			const file = diagnostic.file as ts.SourceFile
			const { line } = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
			return `${file.fileName.slice(ROOT.length + 1)}(${line + 1}): TS${diagnostic.code}`
		})
}

describe("the labs TypeScript", () => {
	it("is part of the test config the check runs, the shipped configs included", () => {
		const labs = config().fileNames.filter((file) => file.startsWith(LABS))
		const configs = ["local", "minimal", "oat", "oob-auth"].map((name) => `${LABS}${name}.config.ts`)
		expect(labs).toEqual(expect.arrayContaining([...configs, `${LABS}serve.ts`]))
	})

	it("type-checks against the source when there is no build", { timeout: 120_000 }, () => {
		const parsed = config()
		expect(labsErrors(parsed, parsed.options)).toEqual([])
	})

	it(
		"would not resolve the build path without rootDirs, so the check above is the mapping's",
		{ timeout: 120_000 },
		() => {
			const parsed = config()
			const { rootDirs: _mapped, ...unmapped } = parsed.options
			expect(labsErrors(parsed, unmapped)).toEqual(
				expect.arrayContaining(["labs/local.config.ts(11): TS2307", "labs/oat.config.ts(7): TS2307"]),
			)
		},
	)
})
