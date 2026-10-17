import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FLAGS } from "../../src/cli.ts"
import { CONFIG } from "../../src/config/validate.ts"
import { DEFECTS } from "../../src/reference/defects.ts"
import { CHECKS } from "../../src/runtime/checks.ts"

/*
 * Every name a user can meet (a check id, a defect, a CLI flag, a top-level config field, an `x-*`
 * tag oat reads, a public export) appears in the doc that explains it. Names undocumented today
 * are listed below; the lists only shrink: documenting one fails the test until it leaves its list.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const doc = (name: string): string => readFileSync(join(ROOT, "docs", name), "utf8")

function sourcesUnder(dir: string): string[] {
	return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
		.map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
}

/* The tags oat reads: every `"x-…"` literal in the spec layer, less the one media type. */
function tagsRead(): string[] {
	const tags = sourcesUnder("src/spec").flatMap((text) =>
		[...text.matchAll(/"(x-[a-z0-9-]+)"/g)].map((m) => m[1] ?? ""),
	)
	return [...new Set(tags)].filter((tag) => tag !== "x-www-form-urlencoded").toSorted()
}

/* The names `src/index.ts` exports, values and types alike. */
function publicExports(): string[] {
	const text = readFileSync(join(ROOT, "src", "index.ts"), "utf8")
	const names = [...text.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((m) =>
		(m[1] ?? "")
			.split(",")
			.map((part) => part.trim().replace(/^type /, ""))
			.filter((part) => part !== "")
			.map((part) => part.split(/\s+as\s+/).at(-1) ?? part),
	)
	return [...new Set(names)].toSorted()
}

interface Surface {
	doc: string
	names: () => string[]
	/** How a documented name appears in its doc. */
	written: (name: string) => string
	/** Undocumented today. Shrink only. */
	undocumented: readonly string[]
}

const code = (name: string): string => `\`${name}\``

const SURFACES: Readonly<Record<string, Surface>> = {
	"check ids": {
		doc: "checks.md",
		names: () => CHECKS.map((check) => check.id),
		written: code,
		undocumented: [
			"auth.destructive-spares-the-caller",
			"auth.self-is-the-caller",
			"list.item-matches-listed-row",
			"read.matches-caller-root",
			"response.contract-call",
			"response.public-get-returns-success",
		],
	},
	defects: {
		doc: "reference-defects.md",
		names: () => Object.keys(DEFECTS),
		written: code,
		undocumented: [
			"CALLER_UPDATE_DROPPED",
			"CONTAINS_MATCHES_SUBSTRING",
			"CREATE_500_ON_NON_ASCII",
			"DEFAULT_ORDER_IGNORED",
			"DISPOSABLE_KILLS_CALLER",
			"FILTER_ALIAS_MISMAPPED",
			"FILTER_CONDITION_CAP_IGNORED",
			"FILTER_DROPPED_WHEN_SORTED_SEARCHED_AND_SELECTED",
			"FILTER_IN_CAP_IGNORED",
			"FILTER_LTE_IS_LT",
			"FILTER_LT_IS_LTE",
			"FILTER_NESTED_COMBINATOR_LEAKS",
			"FILTER_NIN_FIRST_ONLY",
			"LISTED_GET_DIFFERS",
			"NESTED_SELECT_IGNORED",
			"ORDER_DROPPED_WHEN_SELECTED",
			"PUBLIC_GET_NOT_SUCCESS",
			"ROOT_READ_OPEN",
			"SEARCH_CASE_SENSITIVE",
			"SEARCH_DROPPED_WHEN_SELECTED",
			"SEARCH_DROPPED_WHEN_SORTED",
			"SEARCH_EMPTY_MATCHES_NONE",
			"SEARCH_MODE_REJECTED",
			"SEARCH_ONLY_FIRST_TOKEN",
			"SELECT_UNKNOWN_IGNORED",
			"SIDE_EFFECT_NEVER_ARRIVES",
			"SORT_NULLS_MODIFIER_IGNORED",
			"SORT_UNKNOWN_FIELD_IGNORED",
			"SPEC_OVERCLAIMS_FILTER_OP",
			"TOKEN_EXPIRY_AS_STRING",
		],
	},
	"CLI flags": {
		doc: "commands.md",
		names: () => Object.keys(FLAGS),
		written: (name) => `--${name}`,
		undocumented: ["fuzz-seed", "help", "skip-backend"],
	},
	"top-level config fields": {
		doc: "configuration.md",
		names: () => Object.keys(CONFIG),
		written: code,
		undocumented: ["ops", "profiles"],
	},
	"x-* tags": {
		doc: "tags.md",
		names: tagsRead,
		written: code,
		undocumented: ["x-oat-defs"],
	},
	"public exports": {
		doc: "api.md",
		names: publicExports,
		written: code,
		undocumented: [
			"AllocatedRunDir",
			"CheckTiming",
			"CollectionShape",
			"DEFAULT_OUT_OF_BAND",
			"EntityConfig",
			"EntityMatrix",
			"ExternalStep",
			"FieldType",
			"FilterOp",
			"FilterableField",
			"FilterableFrom",
			"InvalidateLink",
			"MatrixGraph",
			"MatrixGraphEdge",
			"MatrixGraphNode",
			"NetworkError",
			"NetworkKind",
			"OperationCoverage",
			"OperationStatus",
			"OperationStep",
			"OutOfBandStep",
			"PathValueRequest",
			"PayloadPolicy",
			"PersistedPrincipal",
			"PrincipalAuth",
			"PrincipalAuthResult",
			"ProfileSpec",
			"QueryCapabilities",
			"QueryCapabilitiesRequest",
			"RateLimitSpec",
			"RequestStep",
			"RunOutcome",
			"Scenario",
			"ScenarioAssert",
			"ScenarioRequestStep",
			"ScenarioStep",
			"ScopeError",
			"ScopePlan",
			"ScopeReport",
			"SideEffectRequest",
			"SupportUse",
			"TargetScope",
			"UploadResolution",
			"buildMatrixGraph",
			"buildModel",
			"classifyNetworkError",
			"configProblems",
			"coverageByCheck",
			"dereference",
			"deriveCollectionShape",
			"deriveIdentity",
			"exitCode",
			"formatRunStamp",
			"interpolate",
			"isAuthFlow",
			"isHookAuth",
			"isNetworkError",
			"isRootCause",
			"loadConfig",
			"loadSpec",
			"matrixViewFromReport",
			"normalisePath",
			"parsePersistedPrincipals",
			"parseRouteRef",
			"planScope",
			"publishLatest",
			"renderConsole",
			"resolveBackoff",
			"resolveTargetScope",
			"runVerdict",
		],
	},
}

describe("docs stay in sync with the code", () => {
	it.each(Object.entries(SURFACES))("%s", (_name, surface) => {
		const text = doc(surface.doc)
		const missing = surface.names().filter((name) => !text.includes(surface.written(name)))
		expect(missing.toSorted()).toEqual([...surface.undocumented].toSorted())
	})
})
