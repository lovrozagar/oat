/**
 * How oat names an operation, and how config names one back.
 *
 * An operation is named by its `operationId`, or, when the document gives it none, `METHOD /path`
 * with the method uppercased. Config may write that method in any case, but the path must be one
 * of the document's path templates exactly, and an operation with an `operationId` answers to that
 * id alone. `ops`, `allow` and `overlay.operations` all resolve through here, so they cannot
 * disagree about what a name means.
 */

import { isRaw, isRecord } from "../config/types/raw.ts"
import { PATH_ITEM_METHODS } from "./methods.ts"
import type { OperationObject } from "./types.ts"

const METHODS: ReadonlySet<string> = /* @__PURE__ */ new Set(PATH_ITEM_METHODS)

/** The name of the operation at `method` and `path`. */
export function operationName(method: string, path: string, operationId: string | undefined): string {
	return operationId ?? `${method.toUpperCase()} ${path}`
}

/** Where an operation sits in a document: its path item and the method under it. */
export interface OperationSlot {
	item: Record<string, unknown>
	method: string
}

/** Each operation of a document's `paths`, by name. */
export function operationSlots(paths: Readonly<Record<string, unknown>>): Map<string, OperationSlot> {
	const slots = new Map<string, OperationSlot>()
	for (const [path, item] of Object.entries(paths)) {
		if (!isRecord(item)) continue
		for (const method of PATH_ITEM_METHODS) {
			const op = item[method]
			if (!isRaw<OperationObject>(op)) continue
			const id = typeof op.operationId === "string" ? op.operationId : undefined
			slots.set(operationName(method, path, id), { item, method })
		}
	}
	return slots
}

/** The operation name in `names` that `ref` refers to, or `undefined` when it refers to none. */
export function resolveOperationName(ref: string, names: { has(name: string): boolean }): string | undefined {
	if (names.has(ref)) return ref
	const space = ref.indexOf(" ")
	if (space < 0) return undefined
	const method = ref.slice(0, space).toLowerCase()
	if (!METHODS.has(method)) return undefined
	const canonical = operationName(method, ref.slice(space + 1), undefined)
	return names.has(canonical) ? canonical : undefined
}
