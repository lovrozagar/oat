import { buildModel } from "../../spec/graph/build.ts"
import { dereference } from "../../spec/load/dereference.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import type { ParserResult } from "../harness/result.ts"
import { type SpecFixture, specFixtures } from "../specs.ts"
import { messageOf } from "../../errors/message.ts"

/**
 * Parser robustness. These fixtures are shapes real published documents contain; the bar is that
 * oat never throws and never hangs on them, not that it models them well.
 */

type Model = ReturnType<typeof buildModel>

/** What one fixture's model must show beyond its counts, by fixture name. */
type Probe = (model: Model, externalRefs: readonly unknown[]) => string[]

const MANGLED_PLURALS = ["statu", "analyse", "peopl", "campuse", "inbo"]

type Operation = Model["operations"][number] | undefined

function querySource(op: Operation): string[] {
	const source = op?.query?.source
	return source === "heuristic" ? [] : [`query source is ${source ?? "null"}, expected heuristic`]
}

function maxLimit(op: Operation): string[] {
	const limit = op?.query?.maxLimit
	return limit === 50 ? [] : [`maxLimit is ${String(limit)}, expected 50 from per_page.maximum`]
}

function roles(op: Operation): string[] {
	const conventions = op?.conventions
	if (conventions?.order === "sort" && conventions.select === "fields" && conventions.search === "q") return []
	return [`roles resolved to order=${conventions?.order} select=${conventions?.select} search=${conventions?.search}`]
}

function rolesByAlias(model: Model): string[] {
	const op = model.operations[0]
	return [...querySource(op), ...maxLimit(op), ...roles(op)]
}

/* A schema ref to nothing reads as unconstrained with a gap; a parameter ref to nothing leaves its operation untested. */
function danglingRef(model: Model): string[] {
	const problems: string[] = []
	if (!model.gaps.gaps.some((gap) => gap.tag === "$ref" && gap.operationId === "payment.list")) {
		problems.push("payment.list has no gap for the schema its $ref names but the document lacks")
	}
	if (model.byOperationId.get("refund.list")?.unsendable == null) {
		problems.push("refund.list was modelled with a parameter its $ref names but the document lacks")
	}
	return problems
}

const PROBES: Readonly<Record<string, Probe>> = {
	"dangling-ref": danglingRef,
	"external-ref": (_, externalRefs) =>
		externalRefs.length === 0 ? ["external $ref was silently resolved instead of reported"] : [],
	"irregular-plurals": (model) =>
		MANGLED_PLURALS.filter((bad) => model.entities.has(bad)).map((bad) => `mangled plural produced entity "${bad}"`),
	"multiple-arrays-in-envelope": (model) => {
		const key = model.operations[0]?.collection?.key
		return key === "reports" ? [] : [`collection key resolved to "${key ?? "none"}", expected "reports"`]
	},
	"pagination-only-is-not-query": (model) => {
		const query = model.operations[0]?.query
		return query === null ? [] : [`query capability inferred from page/limit/status: ${query?.source ?? "unknown"}`]
	},
	"query-roles-by-alias": rolesByAlias,
}

/** The operation and entity counts a fixture expects, where it states them. */
function countProblems(fixture: SpecFixture, model: Model): string[] {
	const problems: string[] = []
	if (fixture.expectOperations !== undefined && model.operations.length !== fixture.expectOperations) {
		problems.push(`expected ${fixture.expectOperations} operation(s), modelled ${model.operations.length}`)
	}
	if (fixture.expectEntities !== undefined && model.entities.size !== fixture.expectEntities) {
		problems.push(`expected ${fixture.expectEntities} entity/entities, modelled ${model.entities.size}`)
	}
	return problems
}

function parseFixture(fixture: SpecFixture): ParserResult {
	try {
		const { doc, externalRefs } = dereference(fixture.doc as OpenApiDocument)
		const model = buildModel(doc)
		const problems = [...countProblems(fixture, model), ...(PROBES[fixture.name]?.(model, externalRefs) ?? [])]
		return {
			detail: problems.join("; ") || `${model.operations.length} ops, ${model.entities.size} entities`,
			name: fixture.name,
			ok: problems.length === 0,
			why: fixture.why,
		}
	} catch (error) {
		return { detail: `threw: ${messageOf(error)}`, name: fixture.name, ok: false, why: fixture.why }
	}
}

export function runParserSuite(fixtures: readonly SpecFixture[] = specFixtures()): ParserResult[] {
	return fixtures.map(parseFixture)
}
