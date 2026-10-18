import { describe, expect, it } from "vitest"
import { report } from "./__fixtures__/reports.ts"
import { invalidateLinks } from "./invalidate.ts"

describe("invalidateLinks", () => {
	const model = report({
		entities: [
			{ name: "table", readSurface: ["GET /table"] },
			{ name: "row", readSurface: ["GET /row", "GET /table/{id}/rows"] },
		],
		invalidates: [
			{
				op: "row.create",
				routes: ["GET /table", "GET /table/{id}/rows", "GET /served", "GET /nowhere"],
				writer: "row",
			},
			{ op: "free.op", routes: ["GET /table"], writer: null },
		],
		routes: { "GET /served": "table", "GET /table": null },
	}).model

	it("names the entity each declared route belongs to, and says when it is another entity", () => {
		expect(invalidateLinks(model)).toEqual([
			{ cross: true, fromEntity: "row", fromOp: "row.create", toEntity: "table", toRoute: "GET /table" },
			{ cross: false, fromEntity: "row", fromOp: "row.create", toEntity: "row", toRoute: "GET /table/{id}/rows" },
			{ cross: true, fromEntity: "row", fromOp: "row.create", toEntity: "table", toRoute: "GET /served" },
			{ cross: false, fromEntity: "row", fromOp: "row.create", toEntity: "row", toRoute: "GET /nowhere" },
		])
	})
})
