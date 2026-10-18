import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FLAGS } from "../../src/cli/flags.ts"
import { CONFIG } from "../../src/config/validate.ts"
import { DEFECTS } from "../../src/reference/defects/table.ts"
import { RUN_FINDING_IDS } from "../../src/runtime/check-ids.ts"
import { CHECKS } from "../../src/runtime/checks/registry.ts"

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
		.filter((entry) => !entry.parentPath.includes("__fixtures__"))
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

/* `token` as a whole word: `env` is not found inside "environment". */
const mentions = (text: string, token: string): boolean =>
	new RegExp(`(?<![\\w-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text)

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
	"run-level finding ids": {
		doc: "checks.md",
		names: () => [...RUN_FINDING_IDS],
		written: code,
		undocumented: [],
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
		undocumented: [],
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
		/* An export may be named in prose or in an example's code. */
		written: (name) => name,
		undocumented: [
			"EntityConfig",
			"ExternalStep",
			"FieldType",
			"FilterOp",
			"FilterableField",
			"FilterableFrom",
			"OperationStep",
			"OutOfBandStep",
			"PathValueRequest",
			"PayloadPolicy",
			"PrincipalAuth",
			"PrincipalAuthResult",
			"ProfileSpec",
			"QueryCapabilities",
			"QueryCapabilitiesRequest",
			"RateLimitSpec",
			"RequestStep",
			"Scenario",
			"ScenarioAssert",
			"ScenarioRequestStep",
			"ScenarioStep",
			"SideEffectRequest",
			"UploadResolution",
		],
	},
}

describe("docs stay in sync with the code", () => {
	it.each(Object.entries(SURFACES))("%s", (_name, surface) => {
		const text = doc(surface.doc)
		const missing = surface.names().filter((name) => !mentions(text, surface.written(name)))
		expect(missing.toSorted()).toEqual([...surface.undocumented].toSorted())
	})
})

/* The reverse: a doc that names a check or a tag the code no longer has teaches a shape that does nothing. */
describe("docs name nothing the code lacks", () => {
	it("every id in the checks.md tables is a registered check or a run-level finding", () => {
		const ids = new Set<string>([...CHECKS.map((check) => check.id), ...RUN_FINDING_IDS])
		const listed = [...doc("checks.md").matchAll(/^\|\s*`([a-z]+\.[a-z0-9.-]+)`/gm)].map((m) => m[1] ?? "")
		expect(listed.length).toBeGreaterThan(0)
		expect(listed.filter((id) => !ids.has(id))).toEqual([])
	})

	it("every x-* name tags.md mentions is one oat reads", () => {
		const read = new Set(tagsRead())
		const mentioned = new Set(
			[...doc("tags.md").matchAll(/(?<![\w-])(x-[a-z0-9]+(?:-[a-z0-9]+)*)/g)].map((m) => m[1] ?? ""),
		)
		expect([...mentioned].filter((tag) => !read.has(tag))).toEqual([])
	})
})
