import { describe, expect, it } from "vitest"
import type { Client } from "../client/client.ts"
import type { Exchange } from "./exchange.ts"
import { proveFromTranscript } from "./evidence.ts"
import { GradeLedger } from "./scope.ts"
import { buildModel } from "../spec/graph/build.ts"
import { dereference } from "../spec/load/dereference.ts"
import type { OpenApiDocument } from "../spec/types.ts"

/*
 * A nested item with no route of its own to read — a column inside its table — is seen only through
 * an ancestor. A delete is shown when the same ancestor read held the id before the call and no
 * longer holds it after. An ancestor that never held the id shows nothing.
 */

const spec: OpenApiDocument = {
	info: { title: "nested-delete", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/tables/{table_id}": {
			get: {
				operationId: "table.get",
				parameters: [{ in: "path", name: "table_id", required: true, schema: { type: "string" } }],
				responses: { "200": { description: "ok" } },
			},
		},
		"/v1/tables/{table_id}/columns/{col_id}": {
			delete: {
				operationId: "column.remove",
				parameters: [
					{ in: "path", name: "table_id", required: true, schema: { type: "string" } },
					{ in: "path", name: "col_id", required: true, schema: { type: "string" } },
				],
				responses: { "200": { description: "ok" } },
			},
		},
	},
} as OpenApiDocument

const BASE = "http://api.test"
const COLUMN = "col_amount_2"

function exchange(seq: number, method: string, path: string, responseBody: unknown, operationId?: string): Exchange {
	return {
		at: seq,
		method,
		requestBody: undefined,
		responseBody,
		seq,
		status: 200,
		url: `${BASE}${path}`,
		...(operationId === undefined ? {} : { operationId }),
	} as Exchange
}

const table = (columns: string[]) => ({ columns_json: columns.map((id) => ({ id })), id: "tbl_1" })

async function evidenceFor(transcript: Exchange[]) {
	const grades = new GradeLedger()
	grades.graded(["column.remove"], "effects.declared-effect-occurs")
	const client = { hydrate: async (e: Exchange) => e, transcript } as unknown as Client
	await proveFromTranscript({ client, grades, model: buildModel(dereference(spec).doc) })
	return grades.evidence.get("column.remove")
}

describe("delete evidence through an ancestor read", () => {
	it("is observed when the ancestor held the id before and lacks it after", async () => {
		const evidence = await evidenceFor([
			exchange(1, "GET", "/v1/tables/tbl_1", table(["col_amount", COLUMN]), "table.get"),
			exchange(2, "DELETE", `/v1/tables/tbl_1/columns/${COLUMN}`, table(["col_amount"]), "column.remove"),
			exchange(3, "GET", "/v1/tables/tbl_1", table(["col_amount"]), "table.get"),
		])
		expect(evidence).toEqual({ call: 2, observation: { absent: true, path: "$", seq: 3, value: COLUMN } })
	})

	it("is not observed when the ancestor never held the id", async () => {
		const evidence = await evidenceFor([
			exchange(1, "GET", "/v1/tables/tbl_1", table(["col_amount"]), "table.get"),
			exchange(2, "DELETE", `/v1/tables/tbl_1/columns/${COLUMN}`, table(["col_amount"]), "column.remove"),
			exchange(3, "GET", "/v1/tables/tbl_1", table(["col_amount"]), "table.get"),
		])
		expect(evidence).toEqual({ call: 2 })
	})
})
