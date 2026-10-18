import { describe, expect, it } from "vitest"
import { fromTemplateTerms } from "./template.ts"

describe("fromTemplateTerms", () => {
	it("reads one term as its canonical form, the underscore written as ~ restored", () => {
		expect(fromTemplateTerms(["and_status_eq_active"])).toBe("status.eq.active")
		expect(fromTemplateTerms(["and_status_ne_a~b"])).toBe("status.neq.a_b")
		expect(fromTemplateTerms(["and_row_count_gte_2"])).toBe("row_count.gte.2")
	})

	it("comma-joins in values and reads like as a bare substring", () => {
		expect(fromTemplateTerms(["and_status_in_a,b~c"])).toBe("status.in.(a,b_c)")
		expect(fromTemplateTerms(["and_name_like_al~pha"])).toBe("name.like.*al_pha*")
	})

	it("reads null tests as terms of their own", () => {
		expect(fromTemplateTerms(["and_note_is_null", "and_slug_isn_null"])).toBe("and(note.is.null,slug.is.notnull)")
	})

	it("requires every and term and at least one or term", () => {
		expect(fromTemplateTerms(["or_a_eq_1"])).toBe("a.eq.1")
		expect(fromTemplateTerms(["or_a_eq_1", "or_b_eq_2"])).toBe("or(a.eq.1,b.eq.2)")
		expect(fromTemplateTerms(["and_a_eq_1", "or_b_eq_2", "or_c_is_null"])).toBe("and(a.eq.1,or(b.eq.2,c.is.null))")
	})

	it("hands an operator the grammar lacks to the canonical layer, which refuses it", () => {
		expect(fromTemplateTerms(["and_name_zz_1"])).toBe("name.zz.1")
		expect(fromTemplateTerms(["or_name_zz_a~b"])).toBe("name.zz.a_b")
	})

	it("refuses nothing at all, and any term it cannot read", () => {
		expect(fromTemplateTerms([])).toBeNull()
		expect(fromTemplateTerms(["and_a_eq_1", "junk"])).toBeNull()
		expect(fromTemplateTerms(["xor_a_eq_1"])).toBeNull()
	})
})
