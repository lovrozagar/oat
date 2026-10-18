import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Context, Node, Rule } from "./ast.ts"
import { isTestCode, repoPath } from "./paths.ts"

/*
 * oat's dependency arrows, low to high:
 *   errors, config/types → security → spec → client, credentials, reference → runtime (checks
 *   included) → runtime/run → config, report, conformance → cli, index
 * A module imports its own layer group or any lower layer. security is a leaf above the errors:
 * it imports nothing else. client and credentials sit below the runtime, so the runtime calls them
 * and never the reverse. Only cli and index import report or conformance (conformance renders
 * through report). The reference backend is a separate program: it never imports the client or
 * the runtime, and only conformance, cli and index import it.
 */
const MESSAGE = "import is outside oat's module boundaries (see AGENTS.md: dependency arrows)"

type Bucket =
	| "errors"
	| "config-types"
	| "security"
	| "spec"
	| "client"
	| "credentials"
	| "reference"
	| "runtime"
	| "run"
	| "config"
	| "report"
	| "conformance"
	| "cli"
	| "index"

const LAYER: Readonly<Record<Bucket, number>> = {
	errors: 0,
	"config-types": 0,
	security: 1,
	spec: 2,
	client: 3,
	credentials: 3,
	reference: 3,
	runtime: 4,
	run: 5,
	config: 6,
	report: 6,
	conformance: 6,
	cli: 7,
	index: 7,
}

/* Buckets on one layer that may import each other. */
const GROUPS: ReadonlyArray<ReadonlySet<Bucket>> = [
	new Set(["client", "credentials"]),
	new Set(["errors", "config-types"]),
	new Set(["conformance", "report"]),
]
const TOP_ONLY: ReadonlySet<string> = new Set(["report", "conformance"])
const REFERENCE_USERS: ReadonlySet<string> = new Set(["reference", "conformance", "cli", "index"])
/* A driver the reference backend loads for one engine, and conformance probes for; oat itself never needs it. */
const REFERENCE_DRIVERS = new Set(["postgres"])
const DRIVER_USERS: ReadonlySet<string> = new Set(["reference", "conformance"])

/* Top-level directories that are a bucket by themselves. */
const DIRECTORIES: ReadonlySet<string> = new Set([
	"errors",
	"spec",
	"security",
	"runtime",
	"client",
	"credentials",
	"reference",
	"config",
	"report",
	"conformance",
])

/* The HTTP client and its transport still live in runtime/ until they move to client/: bucketed by file. */
const CLIENT_FILES: ReadonlySet<string> = new Set(
	["cookies", "exchange", "exchanges", "fence", "headers", "network", "poll", "rate-limit", "sse", "transcript"].map(
		(name) => `runtime/${name}.ts`,
	),
)

function bucket(rel: string): Bucket | "unknown" {
	if (rel === "cli.ts" || rel.startsWith("cli/")) return "cli"
	if (rel === "index.ts") return "index"
	if (rel.startsWith("runtime/run/")) return "run"
	if (rel.startsWith("config/types/")) return "config-types"
	if (CLIENT_FILES.has(rel)) return "client"
	const top = rel.split("/", 1).join("")
	return rel.includes("/") && DIRECTORIES.has(top) ? (top as Bucket) : "unknown"
}

function resolveRel(fromRel: string, spec: string): string {
	const dir = fromRel.split("/").slice(0, -1)
	for (const part of spec.split("/")) {
		if (part === "..") dir.pop()
		else if (part !== ".") dir.push(part)
	}
	return dir.join("/")
}

/* What src may import from npm: the package itself and its runtime dependencies. A
 * devDependency, an unlisted package, and a builtin without `node:` are not among them. */
function declaredPackages(): Set<string> {
	const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
		name: string
		dependencies: Record<string, string>
	}
	return new Set([manifest.name, ...Object.keys(manifest.dependencies)])
}

/* `pkg/sub` → `pkg`, `@scope/pkg/sub` → `@scope/pkg`. */
const packageName = (spec: string): string => spec.split("/", spec.startsWith("@") ? 2 : 1).join("/")

function allowedBetween(from: Bucket | "unknown", to: Bucket | "unknown"): boolean {
	if (from === "unknown" || to === "unknown") return false
	if (to === "reference" && !REFERENCE_USERS.has(from)) return false
	if (from === "reference" && LAYER[to] === LAYER.reference && to !== "reference") return false
	if (from === to || GROUPS.some((group) => group.has(from) && group.has(to))) return true
	if (TOP_ONLY.has(to)) return from === "cli" || from === "index"
	return LAYER[to] < LAYER[from]
}

function allowed(fromRel: string, spec: string, packages: () => Set<string>): boolean {
	if (spec.startsWith("node:")) return true
	const from = bucket(fromRel)
	if (!spec.startsWith(".")) {
		const name = packageName(spec)
		return packages().has(name) || (DRIVER_USERS.has(from) && REFERENCE_DRIVERS.has(name))
	}
	return allowedBetween(from, bucket(resolveRel(fromRel, spec)))
}

interface Importing extends Node {
	source?: { type: string; value?: unknown } | null
}

export const rule: Rule = {
	create(context: Context) {
		const file = repoPath(context.filename)
		const at = file.lastIndexOf("/src/")
		if (at === -1 || isTestCode(file)) return {}
		const fromRel = file.slice(at + "/src/".length)
		let packages: Set<string> | undefined
		const declared = (): Set<string> => (packages ??= declaredPackages())
		const check = (node: Importing): void => {
			const source = node.source
			if (source?.type !== "Literal" || typeof source.value !== "string") return
			if (!allowed(fromRel, source.value, declared)) context.report({ message: MESSAGE, node })
		}
		return {
			ExportAllDeclaration: check,
			ExportNamedDeclaration: check,
			ImportDeclaration: check,
			ImportExpression: check,
		}
	},
}
