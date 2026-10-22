import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import { SqlError } from "../store-api.ts"
import { errorResponse, HttpError, preconditionFailed } from "./errors.ts"

const parsed = (answer: { status: number; body: string }) => ({ body: JSON.parse(answer.body), status: answer.status })

describe("HttpError", () => {
	it("carries a status, an error key and a message", () => {
		const error = new HttpError(409, "conflict", "taken")
		expect(error).toBeInstanceOf(Error)
		expect([error.status, error.errorKey, error.message]).toEqual([409, "conflict", "taken"])
	})
})

describe("errorResponse", () => {
	it("answers a refusal as itself, in the documented error schema", () => {
		expect(parsed(errorResponse(new HttpError(404, "not_found", "gone"), new DefectSet()))).toEqual({
			body: { error_key: "not_found", message: "gone", status: 404, success: false },
			status: 404,
		})
	})

	it("drifts to another error schema under ERROR_SCHEMA_DRIFT", () => {
		const answer = errorResponse(new HttpError(403, "forbidden", "no"), new DefectSet(["ERROR_SCHEMA_DRIFT"]))
		expect(parsed(answer)).toEqual({ body: { detail: "no", error: "forbidden" }, status: 403 })
	})

	it("answers a store's refusal as a 400", () => {
		const answer = errorResponse(new SqlError("invalid_filter", "bad filter"), new DefectSet())
		expect(parsed(answer)).toEqual({
			body: { error_key: "invalid_input", message: "bad filter", status: 400, success: false },
			status: 400,
		})
	})

	it("answers a bad filter as a 500 under ERROR_500_ON_BAD_FILTER, and nothing else", () => {
		const defects = new DefectSet(["ERROR_500_ON_BAD_FILTER"])
		expect(errorResponse(new SqlError("invalid_filter", "bad"), defects).status).toBe(500)
		expect(parsed(errorResponse(new SqlError("invalid_filter", "bad"), defects)).body.error_key).toBe("internal_error")
		expect(errorResponse(new SqlError("invalid_order", "bad"), defects).status).toBe(400)
	})

	it("answers anything else as a 500 with its message", () => {
		expect(parsed(errorResponse(new Error("boom"), new DefectSet()))).toEqual({
			body: { error_key: "internal_error", message: "boom", status: 500, success: false },
			status: 500,
		})
	})
})

describe("preconditionFailed", () => {
	it("answers a 412 problem detail, on its own path, whatever reshapes the other refusals", () => {
		for (const defects of [new DefectSet(), new DefectSet(["ERROR_SCHEMA_DRIFT"])]) {
			const answer = preconditionFailed(defects, "stale")
			expect(answer.headers["content-type"]).toBe("application/problem+json")
			expect(parsed(answer)).toEqual({
				body: { detail: "stale", status: 412, title: "Precondition Failed", type: "about:blank" },
				status: 412,
			})
		}
	})

	it("names another status in the problem than the response's under PROBLEM_JSON_MALFORMED", () => {
		const answer = preconditionFailed(new DefectSet(["PROBLEM_JSON_MALFORMED"]), "stale")
		expect([answer.status, parsed(answer).body.status]).toEqual([412, 400])
	})
})
