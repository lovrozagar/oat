/** The unique suite's document cases: how `x-unique` parses, and where plan and doctor show it. */

import { report } from "../../report/console/report.ts"
import { formatUniqueSets, readUnique } from "../../spec/extensions/unique.ts"
import { buildModel } from "../../spec/graph/build.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { dereference } from "../../spec/load/dereference.ts"
import type { OpenApiDocument, OperationObject } from "../../spec/types.ts"
import type { ParserResult } from "../harness/result.ts"
import { widgetSpec } from "./spec.ts"

function result(name: string, why: string, ok: boolean, detail: string): ParserResult {
	return { detail, name, ok, why }
}

const parsed = (tag: unknown): string[][] | null => readUnique({ "x-unique": tag } as OperationObject)

function shapesCase(): ParserResult {
	const shapes: Array<[string, unknown]> = [
		["list of sets", [["email"], ["workspace_id", "slug"]]],
		["column objects", [{ columns: ["email"] }, { columns: ["workspace_id", "slug"] }]],
		["single string[]", ["email"]],
	]
	const sets = shapes.map(([, tag]) => parsed(tag))
	return result(
		"accepted x-unique shapes parse to column sets",
		"list of sets, {columns}, and a single string[] are the documented forms",
		JSON.stringify(sets[0]) === JSON.stringify([["email"], ["workspace_id", "slug"]]) &&
			JSON.stringify(sets[1]) === JSON.stringify([["email"], ["workspace_id", "slug"]]) &&
			JSON.stringify(sets[2]) === JSON.stringify([["email"]]),
		shapes.map(([name], i) => `${name}=${JSON.stringify(sets[i])}`).join("; "),
	)
}

function malformedCase(): ParserResult {
	const { doc } = dereference({
		info: { title: "malformed", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/things": {
				post: {
					operationId: "thing.create",
					responses: { "201": { description: "ok" } },
					"x-entity": { action: "create", identity: "id", name: "thing" },
					"x-unique": { not: "an array" },
				},
			},
		},
	} as OpenApiDocument)
	const model = buildModel(doc)
	const gap = model.gaps.gaps.some((g) => g.tag === "x-unique")
	const unique = model.byOperationId.get("thing.create")?.unique
	return result(
		"malformed x-unique is absent plus a doctor gap",
		"non-array is not a guess",
		unique === null && gap,
		`unique=${String(unique)} gap=${String(gap)}`,
	)
}

/** The plan of `model`, which tags its widget `[name]`, shows the sets. */
export function planCase(model: SpecModel): ParserResult {
	const plan = report.plan(model, false)
	const unique = model.entities.get("widget")?.unique ?? null
	const shown = plan.includes("x-unique:")
	return result(
		"plan lists x-unique",
		"doctor / plan should show the effective sets",
		shown && plan.includes("[name]") && unique !== null,
		shown ? formatUniqueSets(unique) : "missing from plan",
	)
}

/** The doctor report of `model`, which tags its widget `[name]`, shows the sets. */
export function doctorCase(model: SpecModel): ParserResult {
	const { text } = report.doctor(model, [], false)
	const shown = text.includes("x-unique:")
	return result(
		"doctor lists x-unique",
		"doctor / plan should show the effective sets",
		shown && text.includes("[name]"),
		shown ? "shown" : "missing from doctor",
	)
}

/** Every case about the document alone, in the order the suite reports them. */
export function documentCases(): ParserResult[] {
	const empty = JSON.stringify(parsed([[], []]))
	const tagged = buildModel(widgetSpec({ tag: [["name"], ["email"]] }))
	const none = JSON.stringify(buildModel(widgetSpec({ tag: [] })).byOperationId.get("widget.create")?.unique)
	return [
		shapesCase(),
		result("empty sets are dropped", "[[]] after filtering is explicit none", empty === "[]", empty),
		malformedCase(),
		planCase(tagged),
		doctorCase(tagged),
		result("[] after filter does not run unique checks", "explicit none", none === "[]", none),
	]
}

/** `text`, the doctor report of a widget with no tag, names the checks the tag would unlock. */
export function untaggedDoctorCase(text: string): ParserResult {
	const named = text.includes("x-unique")
	return result(
		"doctor says unique checks do not run without the tag",
		"TAG_UNLOCKS names the locked checks",
		named && text.includes("create.unique-conflict-rejected"),
		named ? "named" : "missing from doctor",
	)
}
