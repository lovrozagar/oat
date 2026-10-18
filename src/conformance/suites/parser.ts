import { buildModel } from "../../spec/graph/build.ts"
import { dereference } from "../../spec/load/dereference.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import type { ParserResult } from "../harness/result.ts"
import { SPEC_FIXTURES } from "../specs.ts"
import { messageOf } from "../../errors/message.ts"

/**
 * Parser robustness. These fixtures are shapes real published documents contain; the bar is that
 * oat never throws and never hangs on them, not that it models them well.
 */

export function runParserSuite(): ParserResult[] {
	return SPEC_FIXTURES.map((fixture) => {
		try {
			const { doc, externalRefs } = dereference(fixture.doc as OpenApiDocument)
			const model = buildModel(doc)

			const problems: string[] = []
			if (fixture.expectOperations !== undefined && model.operations.length !== fixture.expectOperations) {
				problems.push(`expected ${fixture.expectOperations} operation(s), modelled ${model.operations.length}`)
			}
			if (fixture.expectEntities !== undefined && model.entities.size !== fixture.expectEntities) {
				problems.push(`expected ${fixture.expectEntities} entity/entities, modelled ${model.entities.size}`)
			}
			if (fixture.name === "external-ref" && externalRefs.length === 0) {
				problems.push("external $ref was silently resolved instead of reported")
			}
			if (fixture.name === "irregular-plurals") {
				const names = [...model.entities.keys()]
				for (const bad of ["statu", "analyse", "peopl", "campuse", "inbo"]) {
					if (names.includes(bad)) problems.push(`mangled plural produced entity "${bad}"`)
				}
			}
			if (fixture.name === "multiple-arrays-in-envelope") {
				const op = model.operations[0]
				if (op?.collection?.key !== "reports") {
					problems.push(`collection key resolved to "${op?.collection?.key ?? "none"}", expected "reports"`)
				}
			}
			if (fixture.name === "query-roles-by-alias") {
				const op = model.operations[0]
				if (op?.query?.source !== "heuristic") {
					problems.push(`query source is ${op?.query?.source ?? "null"}, expected heuristic`)
				}
				if (op?.query?.maxLimit !== 50) {
					problems.push(`maxLimit is ${String(op?.query?.maxLimit)}, expected 50 from per_page.maximum`)
				}
				if (op?.conventions.order !== "sort" || op?.conventions.select !== "fields" || op?.conventions.search !== "q") {
					problems.push(
						`roles resolved to order=${op?.conventions.order} select=${op?.conventions.select} search=${op?.conventions.search}`,
					)
				}
			}
			if (fixture.name === "pagination-only-is-not-query") {
				const op = model.operations[0]
				if (op?.query !== null) {
					problems.push(`query capability inferred from page/limit/status: ${op?.query?.source ?? "unknown"}`)
				}
			}

			return {
				detail: problems.join("; ") || `${model.operations.length} ops, ${model.entities.size} entities`,
				name: fixture.name,
				ok: problems.length === 0,
				why: fixture.why,
			}
		} catch (error) {
			return {
				detail: `threw: ${messageOf(error)}`,
				name: fixture.name,
				ok: false,
				why: fixture.why,
			}
		}
	})
}
