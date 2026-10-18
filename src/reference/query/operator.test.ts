import { describe, expect, it } from "vitest"
import { ROW } from "../model/row.ts"
import { context } from "./__fixtures__/context.ts"
import { operatorFor } from "./operator.ts"

describe("operatorFor", () => {
	it("refuses an operator the grammar does not have, or drops the term under the defect", () => {
		expect(() => operatorFor("name", "zz", context())).toThrow('unknown operator "zz"')
		expect(operatorFor("name", "zz", context(["FILTER_ILLEGAL_OP_IGNORED"]))).toBeNull()
	})

	it("reads ne through the alias table, and as neq where there is none", () => {
		expect(operatorFor("id", "ne", context())).toBe("neq")
		expect(operatorFor("amount", "ne", context([], {}, ROW))).toBe("neq")
		expect(operatorFor("id", "ne", context(["FILTER_ALIAS_MISMAPPED"]))).toBe("eq")
		expect(operatorFor("id", "eq", context(["FILTER_ALIAS_MISMAPPED"]))).toBe("eq")
	})

	it("holds a field to its operator allowlist in either spelling", () => {
		expect(operatorFor("status", "nin", context())).toBe("nin")
		expect(operatorFor("id", "ne", context())).toBe("neq")
		expect(() => operatorFor("name", "gt", context())).toThrow('operator "gt" is not allowed on "name"')
		expect(operatorFor("name", "gt", context(["FILTER_ILLEGAL_OP_IGNORED"]))).toBeNull()
	})

	it("allows any operator on a field the allowlist does not name", () => {
		expect(operatorFor("bogus", "like", context())).toBe("like")
		expect(operatorFor("amount", "like", context([], {}, ROW))).toBe("like")
	})

	it("refuses like on slug once the document overclaims it", () => {
		expect(operatorFor("slug", "like", context())).toBe("like")
		expect(() => operatorFor("slug", "like", context(["SPEC_OVERCLAIMS_FILTER_OP"]))).toThrow(
			'operator "like" is not supported on "slug"',
		)
		expect(operatorFor("slug", "eq", context(["SPEC_OVERCLAIMS_FILTER_OP"]))).toBe("eq")
		expect(operatorFor("name", "like", context(["SPEC_OVERCLAIMS_FILTER_OP"]))).toBe("like")
	})
})
