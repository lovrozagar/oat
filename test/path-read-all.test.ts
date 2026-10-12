import { describe, expect, it } from "vitest"
import { readAll } from "../src/runtime/path.ts"

const body = {
	topics: [
		{ id: "t_1", name: "Product", subscribed: false },
		{ id: "t_2", name: "Engineering", subscribed: true },
		{ id: 3, name: "Numbered", subscribed: false },
	],
}

describe("readAll", () => {
	it("fans out at [*]", () => {
		expect(readAll(body, "$.topics[*].id")).toEqual(["t_1", "t_2", 3])
	})

	it("keeps only the items a [?(@.field==value)] filter names", () => {
		expect(readAll(body, "$.topics[?(@.id=='t_2')].subscribed")).toEqual([true])
		expect(readAll(body, '$.topics[?(@.id=="t_1")].name')).toEqual(["Product"])
		expect(readAll(body, "$.topics[?(@.id==3)].name")).toEqual(["Numbered"])
		expect(readAll(body, "$.topics[?(@.subscribed==true)].id")).toEqual(["t_2"])
	})

	it("names nothing when no item matches the filter", () => {
		expect(readAll(body, "$.topics[?(@.id=='t_9')].subscribed")).toEqual([])
	})
})
