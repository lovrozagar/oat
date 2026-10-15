/**
 * Ids teardown may delete.
 *
 * Teardown removes what was recorded, so recording is where an id oat merely sent — a value in a
 * request body, a guess — would turn into a DELETE against a row somebody else owns. `ProvenId`
 * is a string that came back from the backend: a response, a record it returned, a listing, an
 * async receipt. The ledger, `onCreate` and `recordCreated` accept nothing else, and the
 * constructors below are the only places allowed to make one (lint rule `oat/proven-id-origin`).
 */

import { findCreatedId } from "./effects.ts"
import { resolveAsyncId } from "./async.ts"

declare const provenBrand: unique symbol

/** An id the backend gave back, never one oat only sent. */
export type ProvenId = string & { readonly [provenBrand]: true }

function scalar(value: unknown): ProvenId | undefined {
	return typeof value === "string" || typeof value === "number" ? (String(value) as ProvenId) : undefined
}

/** The created record's id as a response carried it, nested envelopes included. */
export function answeredId(response: { responseBody: unknown }, keys: readonly string[]): ProvenId | undefined {
	return scalar(findCreatedId(response.responseBody, keys))
}

/** The identity of a record the backend returned: a create's answer, a read, a listed row. */
export function returnedId(record: Record<string, unknown>, identity: string): ProvenId | undefined {
	return scalar(record[identity])
}

/** Ids a listing returned. */
export function listedIds(ids: readonly string[]): ProvenId[] {
	return ids.map((id) => id as ProvenId)
}

/** The job id an async start's receipt (its response, or the stream's id frame) names. */
export function receiptId(receipt: unknown, idFrom: string): ProvenId | undefined {
	return scalar(resolveAsyncId(receipt, idFrom))
}
