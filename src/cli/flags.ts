/* The command line: every command and flag once, parsed from argv and printed as the help. */

type FlagKind = "boolean" | "value" | "optional-value"

export interface FlagSpec {
	kind: FlagKind
	/** A value that must parse as a number of this kind. */
	number?: "integer" | "positive"
	/** How the help names the value: `<file>`, `[n]`. */
	value?: string
	/** One line of help; a flag two commands share says what it means to each. */
	help: string
}

/** Every flag, once: whether it takes a value, what kind, and what it is for. Parsing and help both read this. */
export const FLAGS: Readonly<Record<string, FlagSpec>> = {
	config: { help: "oat config module (.ts/.js/.mjs/.json) with a default export", kind: "value", value: "<file>" },
	spec: { help: "OpenAPI document, http(s) URL or filesystem path", kind: "value", value: "<url|file>" },
	"base-url": { help: "backend under test, overriding the config", kind: "value", value: "<url>" },
	ops: {
		help: "comma-separated operationIds to grade (row.*, cdn:asset.get); the rest is support",
		kind: "value",
		value: "<ids>",
	},
	only: {
		help: "run, plan: comma-separated entities, each grading every operation it owns; conformance: defect names",
		kind: "value",
		value: "<names>",
	},
	profile: {
		help: "named profile gating which operations run (built-in: full, cheap)",
		kind: "value",
		value: "<name>",
	},
	seed: {
		help: "integer seed for fixture generation (default 1); with --fuzz or --precision, the seed that replays a case",
		kind: "value",
		number: "integer",
		value: "<n>",
	},
	out: {
		help: "run: history root, each run is <out>/<datetime>/ (default ./.oat/runs); baseline: the file written; init: the config written (default ./oat.config.ts)",
		kind: "value",
		value: "<dir|file>",
	},
	report: {
		help: "run: comma-separated reports to write beside the run's own; junit writes junit.xml in the run directory",
		kind: "value",
		value: "<names>",
	},
	"keep-fixtures": { help: "leave created records in place instead of tearing them down", kind: "boolean" },
	"keep-credentials": {
		help: "write the credentials the run held to .oat/credentials.json (mode 0600), never under --out",
		kind: "boolean",
	},
	"max-in-flight": {
		help: "requests allowed in flight at once (default 4)",
		kind: "value",
		number: "positive",
		value: "<n>",
	},
	quiet: { help: "no live progress on stderr (progress.log still written)", kind: "boolean" },
	"save-exchanges": {
		help: "persist every HTTP exchange under the run dir (default unless --profile cheap)",
		kind: "boolean",
	},
	"no-save-exchanges": { help: "skip the exchange journal (cheap CI)", kind: "boolean" },
	untagged: { help: "serve (or test) a document with every x-* tag stripped", kind: "boolean" },
	defects: { help: "serve: comma-separated defects the demo API injects", kind: "value", value: "<names>" },
	backend: {
		help: "conformance and serve storage: memory | sqlite | postgres | d1 (default: all local; d1 is remote and opt-in)",
		kind: "value",
		value: "<name>",
	},
	dialect: {
		help: "API shape: postgrest | classic | linked | jsonapi | plain | template (default: all)",
		kind: "value",
		value: "<name>",
	},
	parser: { help: "conformance: the document and suite checks only, without the defect matrix", kind: "boolean" },
	fuzz: {
		help: "conformance: inject random defect combinations instead of one at a time",
		kind: "optional-value",
		number: "positive",
		value: "[n]",
	},
	precision: {
		help: "conformance: vary cohort data against a correct backend; any finding is a false positive",
		kind: "optional-value",
		number: "positive",
		value: "[n]",
	},
	"max-defects": {
		help: "conformance: most defects per combination (default 4)",
		kind: "value",
		number: "positive",
		value: "<n>",
	},
	"fuzz-seed": {
		help: "conformance: seed for the combination pass of a full run (default 1)",
		kind: "value",
		number: "positive",
		value: "<n>",
	},
	jobs: {
		help: "conformance: legs run at once, each on its own thread (default: CPUs − 1, at most 4)",
		kind: "value",
		number: "positive",
		value: "<n>",
	},
	"skip-backend": {
		help: "conformance: comma-separated backends a full run may leave out when unreachable",
		kind: "value",
		value: "<names>",
	},
	legs: {
		help: "conformance: run only these parts — suites, passes, shapes, recall, scope, fuzz",
		kind: "value",
		value: "<legs>",
	},
	shapes: {
		help: "conformance: the shapes the shapes and recall legs judge behind; all when absent",
		kind: "value",
		value: "<names>",
	},
	"proven-out": {
		help: "conformance: write the checks this run's defects proved to a file, for --aggregate",
		kind: "value",
		value: "<file>",
	},
	aggregate: {
		help: "conformance: judge the proven-check files of a sharded run together; fails on any check none proved",
		kind: "value",
		value: "<dir>",
	},
	json: { help: "machine-readable output, for plan, doctor and diff", kind: "boolean" },
	from: { help: "baseline: the run folder (or latest) whose findings become known", kind: "value", value: "<run>" },
	force: { help: "baseline, init: overwrite an existing --out file", kind: "boolean" },
	help: { help: "print this help", kind: "boolean" },
}

/** Whether some command takes `--name`. */
export function isKnownFlag(name: string): boolean {
	return Object.hasOwn(FLAGS, name)
}

/** Every command: how it is called, and what it does. */
export const COMMANDS: ReadonlyArray<{ usage: string; help: string }> = [
	{ help: "test a live backend and write a report", usage: "run     --config <file>" },
	{ help: "derive and print the test model (offline)", usage: "plan    --spec <url|file>" },
	{ help: "report what oat can and cannot test, and why", usage: "doctor  --spec <url|file>" },
	{
		help: "write a starter oat.config.ts from the document's security schemes",
		usage: "init    --spec <url|file> [--out file]",
	},
	{ help: "run a demo API to point oat at", usage: "serve   [--defects A,B]" },
	{ help: "self-test: injected defects vs detection", usage: "conformance" },
	{ help: "write a known-findings baseline from a run's report", usage: "baseline --from <run> [--out file]" },
	{ help: "new, fixed and persisting findings between two runs", usage: "diff    <runA> <runB> [--json]" },
]

/** The help, made from the tables above: a flag cannot exist without its line. */
export const USAGE: string = /* @__PURE__ */ usage()

function usage(): string {
	const column = Math.max(...COMMANDS.map((command) => command.usage.length)) + 3
	const commands = COMMANDS.map((command) => `  oat ${command.usage.padEnd(column)}${command.help}`)
	const named = Object.entries(FLAGS).map(([name, spec]) => [
		`--${name}${spec.value === undefined ? "" : ` ${spec.value}`}`,
		spec.help,
	])
	const width = Math.max(...named.map(([flag]) => (flag as string).length)) + 2
	const flags = named.map(([flag, help]) => `  ${(flag as string).padEnd(width)}${help}`)
	return `oat — OpenAPI Tester\n\n${commands.join("\n")}\n\nFlags\n${flags.join("\n")}\n`
}

/** A command and its flags, as parsed. */
export interface Args {
	command: string
	flags: Record<string, string | true>
	/** Arguments that are not flags or flag values, in order: `oat diff <runA> <runB>`. Absent when none. */
	positionals?: string[]
}

/**
 * `oat <command> [--flag value | --flag=value | --switch] …`. A value flag must have its value;
 * a switch takes none; a numeric value must be one. The first problem is returned as `error`
 * rather than guessed around: `--max-in-flight -1` once hung a run, `--seed abc` seeded strings
 * with `NaN`, and a flag followed by another flag silently became `true`.
 */
export function parseArgs(argv: readonly string[]): Args & { error?: string } {
	const leadingFlag = argv[0]?.startsWith("--") === true
	const command = leadingFlag ? "help" : (argv[0] ?? "help")
	const rest = leadingFlag ? argv : argv.slice(1)
	const flags: Record<string, string | true> = {}
	const positionals: string[] = []
	let error: string | undefined
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i] as string
		if (!token.startsWith("--")) {
			positionals.push(token)
			continue
		}
		const read = readFlag(token, rest[i + 1])
		if (read.consumed) i++
		error ??= read.error
		flags[read.key] = read.value
	}
	const extra = positionals.length === 0 ? {} : { positionals }
	return error === undefined ? { command, flags, ...extra } : { command, error, flags, ...extra }
}

/** One flag, its value inline, from the next token, or none; with the first problem it has. */
function readFlag(
	token: string,
	next: string | undefined,
): { key: string; value: string | true; consumed: boolean; error?: string | undefined } {
	const equals = token.indexOf("=")
	const key = equals === -1 ? token.slice(2) : token.slice(2, equals)
	const inline = equals === -1 ? undefined : token.slice(equals + 1)
	const spec = FLAGS[key]
	if (spec === undefined || spec.kind === "boolean") {
		const error = inline !== undefined && spec !== undefined ? `--${key} takes no value` : undefined
		return { consumed: false, error, key, value: inline ?? true }
	}
	if (inline !== undefined) return { consumed: false, error: numberProblem(key, spec, inline), key, value: inline }
	if (next !== undefined && !next.startsWith("--")) {
		return { consumed: true, error: numberProblem(key, spec, next), key, value: next }
	}
	return {
		consumed: false,
		error: spec.kind === "optional-value" ? undefined : `--${key} needs a value`,
		key,
		value: true,
	}
}

function numberProblem(key: string, spec: FlagSpec, value: string): string | undefined {
	if (spec.number === undefined) return undefined
	const parsed = Number(value)
	const integer = value.trim() !== "" && Number.isSafeInteger(parsed)
	if (integer && (spec.number !== "positive" || parsed >= 1)) return undefined
	return `--${key} must be ${spec.number === "positive" ? "a positive" : "an"} integer, got "${value}"`
}

/** The first flag no command knows, when there is one. */
export function unknownFlag(flags: Record<string, string | true>): string | undefined {
	return Object.keys(flags).find((key) => !isKnownFlag(key))
}

/** A flag's value as given, or nothing when it is absent or a bare switch. */
export function str(flags: Args["flags"], key: string): string | undefined {
	const value = flags[key]
	return typeof value === "string" ? value : undefined
}

/** A comma-separated flag's items, trimmed, without empty ones. */
export function list(flags: Args["flags"], key: string): string[] | undefined {
	return str(flags, key)
		?.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
}
