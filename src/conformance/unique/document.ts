/** The unique suite's document cases: how `x-unique` parses, and where plan and doctor show it. */

import { report } from "../../report/console/report.ts"
import { formatUniqueSets, readUnique } from "../../spec/extensions/unique.ts"
import { buildModel } from "../../spec/graph/build.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { dereference } from "../../spec/load/dereference.ts"
import type { OpenApiDocument, OperationObject } from "../../spec/types.ts"
import type { ParserResult } from "../harness/result.ts"
import { widgetSpec } from "./spec.ts"

const parsed = (tag: unknown): string[][] | null => readUnique({ "x-unique": tag } as OperationObject)

function shapesCase(): ParserResult {
	const shapes: Array<[string, unknown]> = [
		["list of sets", [["email"], ["workspace_id", "slug"]]],
		["column objects", [{ columns: ["email"] }, { columns: ["workspace_id", "slug"] }]],
		["single string[]", ["email"]],
	]
	const sets = shapes.map(([, tag]) => parsed(tag))
	return {
		detail: shapes.map(([name], i) => `${name}=${JSON.stringify(sets[i])}`).join("; "),
		name: "accepted x-unique shapes parse to column sets",
		ok:
			JSON.stringify(sets[0]) === JSON.stringify([["email"], ["workspace_id", "slug"]]) &&
			JSON.stringify(sets[1]) === JSON.stringify([["email"], ["workspace_id", "slug"]]) &&
			JSON.stringify(sets[2]) === JSON.stringify([["email"]]),
		why: "list of sets, {columns}, and a single string[] are the documented forms",
	}
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
	return {
		detail: `unique=${String(unique)} gap=${String(gap)}`,
		name: "malformed x-unique is absent plus a doctor gap",
		ok: unique === null && gap,
		why: "non-array is not a guess",
	}
}

/** The plan of `model`, which tags its widget `[name]`, shows the sets. */
export function planCase(model: SpecModel): ParserResult {
	const plan = report.plan(model, false)
	const unique = model.entities.get("widget")?.unique ?? null
	const shown = plan.includes("x-unique:")
	return {
		detail: shown ? formatUniqueSets(unique) : "missing from plan",
		name: "plan lists x-unique",
		ok: shown && plan.includes("[name]") && unique !== null,
		why: "doctor / plan should show the effective sets",
	}
}

/** The doctor report of `model`, which tags its widget `[name]`, shows the sets. */
export function doctorCase(model: SpecModel): ParserResult {
	const { text } = report.doctor(model)
	const shown = text.includes("x-unique:")
	return {
		detail: shown ? "shown" : "missing from doctor",
		name: "doctor lists x-unique",
		ok: shown && text.includes("[name]"),
		why: "doctor / plan should show the effective sets",
	}
}

/** Every case about the document alone, in the order the suite reports them. */
export function documentCases(): ParserResult[] {
	const empty = JSON.stringify(parsed([[], []]))
	const tagged = buildModel(widgetSpec({ tag: [["name"], ["email"]] }))
	const none = JSON.stringify(buildModel(widgetSpec({ tag: [] })).byOperationId.get("widget.create")?.unique)
	return [
		shapesCase(),
		{
			detail: empty,
			name: "empty sets are dropped",
			ok: empty === "[]",
			why: "[[]] after filtering is explicit none",
		},
		malformedCase(),
		planCase(tagged),
		doctorCase(tagged),
		{
			detail: none,
			name: "[] after filter does not run unique checks",
			ok: none === "[]",
			why: "explicit none",
		},
	]
}

/** `text`, the doctor report of a widget with no tag, names the checks the tag would unlock. */
export function untaggedDoctorCase(text: string): ParserResult {
	const named = text.includes("x-unique")
	return {
		detail: named ? "named" : "missing from doctor",
		name: "doctor says unique checks do not run without the tag",
		ok: named && text.includes("create.unique-conflict-rejected"),
		why: "TAG_UNLOCKS names the locked checks",
	}
}
