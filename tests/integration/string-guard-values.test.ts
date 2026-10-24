import { describe, expect, it } from "vitest"
import { PHONE_PATTERN, STRING_GUARD } from "../../src/reference/model/string-guard.ts"
import { shapedEntities } from "../../src/reference/model/shaped.ts"
import { buildSpec } from "../../src/reference/spec/build.ts"
import { generate } from "../../src/runtime/generate/generate.ts"
import type { Variant } from "../../src/runtime/generate/types.ts"
import type { JsonSchema } from "../../src/spec/types.ts"

/*
 * Behind the string-guard shape every written string carries a guard pattern, and the table's
 * phone carries its own beside it in an `allOf`. The values oat makes for a create stay what a
 * person would type: a guard on every string once turned every name into "\0", "\1" and so on.
 */

const VARIANTS: readonly Variant[] = ["baseline", "lexical-first", "lexical-last", "unicode", "metacharacter"]

/* The table's create body as the guarded document declares it. */
function tableCreate(): JsonSchema {
	const shape = { stringGuard: true }
	const document = buildSpec(undefined, { entities: shapedEntities(shape), shape }) as {
		paths: Record<string, { post?: { requestBody?: { content: Record<string, { schema: JsonSchema }> } } }>
	}
	const schema =
		document.paths["/v1/projects/{project_id}/tables"]?.post?.requestBody?.content["application/json"]?.schema
	if (schema === undefined) throw new Error("the guarded document declares no table create")
	return schema
}

describe("values behind the string-guard shape", () => {
	const schema = tableCreate()

	it("declares the guard, and the phone's own pattern beside it in an allOf", () => {
		const properties = schema.properties as Record<string, JsonSchema>
		expect(properties["name"]?.pattern).toBe(STRING_GUARD)
		expect(JSON.stringify(properties["phone"])).toContain(JSON.stringify(PHONE_PATTERN))
	})

	it("names each cohort record in plain text, and gives a phone both patterns admit", () => {
		const values = VARIANTS.map((variant, index) => {
			const made = generate(schema, { index, variant })
			if (!made.ok) throw new Error(`${variant}: ${made.reason}`)
			return made.value as { name: string; phone?: string | null }
		})
		const unreadable = values
			.map((value) => value.name)
			.filter((name) => !/\p{L}{3}/u.test(name) || /\p{Cc}/u.test(name))
		expect(unreadable).toEqual([])
		const phones = values.map((value) => value.phone).filter((phone): phone is string => typeof phone === "string")
		const patterns = [PHONE_PATTERN, STRING_GUARD].map((pattern) => new RegExp(pattern, "u"))
		expect(phones.filter((phone) => !patterns.every((pattern) => pattern.test(phone)))).toEqual([])
	})
})
