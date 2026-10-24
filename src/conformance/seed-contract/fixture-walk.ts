/**
 * The fixture walk on schemas a real document trips: `z.unknown()` / `z.record` after `$ref`
 * inlining, identity cycles, string bounds a pattern must honor, and bounds that cannot be met.
 */

import { messageOf } from "../../errors/message.ts"
import {
	buildCohort,
	FixtureOverflow,
	generateBody,
	isOverflowError,
	mulberry32,
	overflowFrom,
} from "../../runtime/fixture.ts"
import { codePointCount } from "../../runtime/payloads.ts"
import { dereference } from "../../spec/load/dereference.ts"
import { documentDefs } from "../../spec/load/defs.ts"
import type { JsonSchema, OpenApiDocument } from "../../spec/types.ts"
import type { ParserResult } from "../harness/result.ts"

/** One fixture-walk case: what it is called, why it matters, and what it found. */
export interface WalkCase {
	name: string
	why: string
	probe: () => { ok: boolean; detail: string }
}

function columnDefaults(): { ok: boolean; detail: string } {
	const column = {
		additionalProperties: {},
		default: {},
		properties: { name: { type: "string" } },
		required: ["name"],
		type: "object",
	}
	const schema = { properties: { columns: { items: column, type: "array" } }, required: ["columns"], type: "object" }
	const [body] = buildCohort(schema, 1, { operationId: "table.create", variants: ["baseline"] }).map(
		(member) => member.body,
	)
	return { detail: JSON.stringify(body).slice(0, 120), ok: Array.isArray(body?.["columns"]) }
}

function cyclicRef(): { ok: boolean; detail: string } {
	const { doc } = dereference({
		components: { schemas: { Node: { properties: { child: { $ref: "#" } }, type: "object" } } },
		info: { title: "cycle", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/tables": {
				post: {
					operationId: "table.create",
					requestBody: { content: { "application/json": { schema: { $ref: "#" } } }, required: true },
					responses: { "201": { description: "ok" } },
					"x-entity": { action: "create", identity: "id", name: "table" },
				},
			},
		},
	} as OpenApiDocument)
	const schema = (
		doc.paths?.["/tables"] as { post?: { requestBody?: { content?: Record<string, { schema?: unknown }> } } }
	)?.post?.requestBody?.content?.["application/json"]?.schema as Record<string, unknown>
	/* A cohort has one member per variant, or the walk throws: getting here is the pass. */
	const cohort = buildCohort(schema, 1, {
		defs: documentDefs(doc),
		operationId: "table.create",
		variants: ["baseline"],
	})
	return { detail: "body returned", ok: cohort.length === 1 }
}

function emailFormat(): { ok: boolean; detail: string } {
	const schema = { properties: { email: { format: "email", type: "string" } }, required: ["email"], type: "object" }
	const [member] = buildCohort(schema, 1, { operationId: "user.create", variants: ["baseline"] })
	const email = member?.body["email"]
	return {
		detail: String(email),
		ok: typeof email === "string" && /^[^@]+@[^@]+\.[^@]+$/.test(email),
	}
}

const HANDLE = "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"

/** A string bounded in length, following `pattern` when it has one. */
interface BoundedString {
	maxLength: number
	minLength: number
	pattern?: string
	type: "string"
}

/** A sign-up form: a required handle and name, each a bounded string. */
interface SignUpSchema extends JsonSchema {
	properties: { handle: BoundedString; name: BoundedString }
	required: string[]
	type: "object"
}

/** The handle and name a sign-up form asks for: a slug pattern with a floor, and a bounded name. */
export const HANDLE_SCHEMA: SignUpSchema = {
	properties: {
		handle: { maxLength: 32, minLength: 3, pattern: HANDLE, type: "string" },
		name: { maxLength: 32, minLength: 3, type: "string" },
	},
	required: ["handle", "name"],
	type: "object",
}

/* Every cohort member's handle matches the pattern and is not `a`, and every name is in [3, 32]. */
export function boundedPattern(schema: JsonSchema): { ok: boolean; detail: string } {
	const members = buildCohort(schema, 1, { operationId: "user.create" })
	const re = new RegExp(HANDLE)
	const ok = members.every(({ body: { handle, name } }) => {
		const n = codePointCount(String(name))
		return (
			typeof handle === "string" &&
			handle !== "a" &&
			re.test(handle) &&
			codePointCount(handle) >= 3 &&
			typeof name === "string" &&
			n >= 3 &&
			n <= 32
		)
	})
	return { detail: ok ? `${members.length} variants` : JSON.stringify(members.map((m) => m.body)), ok }
}

function impossibleBounds(): { ok: boolean; detail: string } {
	const bounded = { maxLength: 3, minLength: 10, type: "string" }
	const schema = { properties: { opt: bounded, req: bounded }, required: ["req"], type: "object" }
	const { body, missingRequired } = generateBody(schema, { index: 0, rand: mulberry32(1), variant: "baseline" })
	return {
		detail: `body=${JSON.stringify(body)} missing=${missingRequired.join(",")}`,
		ok: body["opt"] === undefined && body["req"] === undefined && missingRequired.includes("/req"),
	}
}

function namedOverflow(): { ok: boolean; detail: string } {
	overflowFrom(new RangeError("Maximum call stack size exceeded"), "table.create")
	const named = new FixtureOverflow("table.create", "/columns_json")
	return {
		detail: named.message,
		ok: named.message.includes("table.create") && !named.message.includes("unknown") && isOverflowError(named),
	}
}

export const FIXTURE_WALK: readonly WalkCase[] = [
	{
		name: "default: {} on a column object seeds",
		probe: columnDefaults,
		why: "z.unknown() / default: {} must not recurse",
	},
	{
		name: "cyclic $ref: # after deref does not throw",
		probe: cyclicRef,
		why: "inlined identity cycles must terminate",
	},
	{
		name: "format: email matches a conservative regex",
		probe: emailFormat,
		why: "required email must not be Quarterly Report N",
	},
	{
		name: "fixture strings honor minLength with pattern",
		probe: () => boundedPattern(HANDLE_SCHEMA),
		why: "handle must not be a; every cohort name is in [3, 32]",
	},
	{
		name: "minLength > maxLength is a generation gap",
		probe: impossibleBounds,
		why: "omit optional; missingRequired on required; do not loop",
	},
	{
		name: "overflow names table.create, not unknown",
		probe: namedOverflow,
		why: "RangeError must become a named fixture gap",
	},
]

/** Each case's verdict; a case that throws fails with the error's message, and the rest still run. */
export function runFixtureWalkCases(cases: readonly WalkCase[] = FIXTURE_WALK): ParserResult[] {
	return cases.map(({ name, probe, why }) => {
		try {
			const { detail, ok } = probe()
			return { detail, name, ok, why }
		} catch (error) {
			return { detail: messageOf(error), name, ok: false, why }
		}
	})
}
