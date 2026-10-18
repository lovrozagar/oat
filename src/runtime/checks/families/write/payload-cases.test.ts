import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../../../spec/graph.ts"
import { REQUIRED_IDS, STRING_PAYLOADS } from "../../../payloads.ts"
import { contextFor, modelOf, op } from "../../__fixtures__/harness.ts"
import type { CheckContext } from "../../core/context.ts"
import { payloadCases, pickPayloadField } from "./payload-cases.ts"
import { widgetApi, widgetDoc } from "./__fixtures__/widget-api.ts"

function stage(properties: Record<string, unknown>, update: Partial<OperationModel> = {}) {
	const model = modelOf(widgetDoc({ item: { properties, type: "object" } }))
	const { ctx } = contextFor(model, "listWidgets", widgetApi(), {
		createOp: op(model, "createWidget"),
		readOp: op(model, "getWidget"),
		updateOp: { ...op(model, "updateWidget"), ...update },
	})
	return { ctx, model }
}

const picked = (properties: Record<string, unknown>, update: Partial<OperationModel> = {}) => {
	const { ctx, model } = stage(properties, update)
	return pickPayloadField(ctx, op(model, "updateWidget"))
}

describe("pickPayloadField", () => {
	it("prefers a nullable string, then the roomiest", () => {
		expect(picked({ big: { maxLength: 900, type: "string" }, small: { maxLength: 20, type: "string" } })).toEqual({
			maxLength: 900,
			minLength: undefined,
			name: "big",
			score: 900,
		})
		expect(picked({ big: { maxLength: 900, type: "string" }, open: { type: ["string", "null"] } })?.name).toBe("open")
		expect(picked({ big: { type: "string" }, flagged: { nullable: true, type: "string" } })?.name).toBe("flagged")
		expect(picked({ first: { type: "string" }, second: { type: "string" } })?.name).toBe("first")
	})

	it("takes the string branch of a union, and a null branch makes it nullable", () => {
		const union = { oneOf: [null, { type: "string", maxLength: 50, minLength: 2 }, { type: "null" }] }
		expect(picked({ plain: { type: "string" }, union })).toEqual({
			maxLength: 50,
			minLength: 2,
			name: "union",
			score: 1050,
		})
		const anyOf = { anyOf: [{ type: "integer" }, { type: "string" }] }
		expect(picked({ anyOf })).toEqual({ maxLength: undefined, minLength: undefined, name: "anyOf", score: 1024 })
		/* A union that is not a list is no union: the property's own (absent) type stands. */
		expect(picked({ odd: { oneOf: { type: "string" } } })?.name).toBe("odd")
	})

	it("skips what an arbitrary string cannot be written into", () => {
		const skipped = {
			code: { pattern: "^x$", type: "string" },
			count: { type: "integer" },
			created_at: { type: "string" },
			email: { format: "email", type: "string" },
			fixed: { type: "string" },
			id: { type: "string" },
			made: { type: "string" },
			nothing: null,
			owner_id: { type: "string" },
			secret: { readOnly: true, type: "string" },
			stamp: { type: "string" },
			status: { enum: ["a"], type: "string" },
			tiny: { maxLength: 7, type: "string" },
			truth: true,
		}
		const { ctx, model } = stage(skipped, { generated: ["stamp"], immutable: ["fixed"] })
		const createOp = { ...op(model, "createWidget"), generated: ["made"] }
		expect(pickPayloadField({ ...ctx, createOp }, op(model, "updateWidget"))).toBeNull()
		expect(pickPayloadField({ ...ctx, createOp }, op(model, "listWidgets"))).toBeNull()
		/* With no update or create to say what is immutable, only the identity is held back. */
		const bare = pickPayloadField({ ...ctx, createOp: undefined, updateOp: undefined }, op(model, "updateWidget"))
		expect(["fixed", "made", "stamp"]).toContain(bare?.name)
		expect(picked({ untyped: {}, wide: { type: ["string", "integer"] } })?.name).toBe("untyped")
	})
})

describe("payloadCases", () => {
	const field = { maxLength: undefined, minLength: undefined, name: "name" }
	const all = (ctx: CheckContext, writeOp: OperationModel) => payloadCases(ctx, writeOp, field)

	it("sends the whole fitting catalog without a policy, or under the full one", () => {
		const { ctx, model } = stage({ name: { type: "string" } })
		const writeOp = op(model, "updateWidget")
		expect(all(ctx, writeOp)).toEqual({ cases: [...STRING_PAYLOADS], narrowed: null })
		const full = { ...ctx, payloads: { policy: "full" as const, ran: new Map() } }
		expect(all(full, writeOp)).toEqual({ cases: [...STRING_PAYLOADS], narrowed: null })
		const capped = payloadCases(ctx, writeOp, { ...field, maxLength: 8, minLength: 1 })
		expect(capped.cases.length).toBeLessThan(STRING_PAYLOADS.length)
		expect(capped.cases.every((payload) => payload.value.length >= 1 && [...payload.value].length <= 8)).toBe(true)
	})

	it("runs the whole catalog once per write path, then one case of each family", () => {
		const { ctx, model } = stage({
			free: {},
			mail: { format: "email", type: "string" },
			name: { type: "string" },
			slug: { type: "integer" },
		})
		const writeOp = op(model, "updateWidget")
		const ran = new Map<string, string>()
		const first = { ...ctx, entityName: "widget", payloads: { policy: "per-write-path" as const, ran } }
		expect(all(first, writeOp).narrowed).toBeNull()
		expect([...ran]).toEqual([['application/json|["string",null]', "widget"]])
		const second = { ...first, entityName: "gadget" }
		const narrowed = all(second, writeOp)
		expect(narrowed.narrowed).toBe("widget")
		expect(narrowed.cases.map((payload) => payload.id).sort()).toEqual(
			STRING_PAYLOADS.filter((payload) => (REQUIRED_IDS as readonly string[]).includes(payload.id))
				.map((payload) => payload.id)
				.sort(),
		)
		/* Another field type or format is another path; a field with no type is a string's. */
		expect(payloadCases(second, writeOp, { ...field, name: "slug" }).narrowed).toBeNull()
		expect(payloadCases(second, writeOp, { ...field, name: "free" }).narrowed).toBe("widget")
		expect(payloadCases(second, writeOp, { ...field, name: "mail" }).narrowed).toBeNull()
		expect([...ran.keys()]).toContain('application/json|["string","email"]')
		/* A field neither the body nor the item declares is keyed as a plain string. */
		expect(payloadCases(second, writeOp, { ...field, name: "undeclared" }).narrowed).toBe("widget")
	})

	it("keys a path with no request body, or no raw operation, by an empty media type", () => {
		const { ctx, model } = stage({ name: { type: "string" } })
		const ran = new Map<string, string>()
		const policed = { ...ctx, payloads: { policy: "per-write-path" as const, ran } }
		all(policed, op(model, "getWidget"))
		all({ ...policed, model: { ...model, rawOperations: new Map() } }, op(model, "deleteWidget"))
		expect([...ran.keys()]).toEqual(['|["string",null]'])
	})
})
