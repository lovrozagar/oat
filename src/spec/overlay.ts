/**
 * Patches to a document the tester cannot change, applied from config before anything reads it.
 *
 * An operation is addressed by its `operationId`, a schema by its name under
 * `components.schemas`. Objects merge, arrays replace, and `null` deletes the key, so a patch can
 * add a tag, fix a constraint or restate a parameter list without copying the rest. A patch that
 * names nothing is a mistake in the config, and stops the run before it starts.
 */

import { UsageError } from "../errors/usage-error.ts"
import type { SpecOverlay } from "../config/types/config.ts"
import type { OpenApiDocument } from "./types.ts"

export type { SpecOverlay } from "../config/types/config.ts"

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/** `base` with `patch` laid over it: objects merge, arrays and scalars replace, `null` deletes. */
function merge(base: unknown, patch: unknown): unknown {
	if (!isRecord(patch) || !isRecord(base)) return structuredClone(patch)
	const out: Record<string, unknown> = { ...base }
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete out[key]
		else out[key] = merge(base[key], value)
	}
	return out
}

export function applyOverlay(doc: OpenApiDocument, overlay: SpecOverlay): OpenApiDocument {
	const out = structuredClone(doc)
	patchOperations(operationsById(out), overlay.operations ?? {})
	patchSchemas((out.components?.schemas ?? {}) as Record<string, unknown>, overlay.schemas ?? {})
	return out
}

interface OperationSlot {
	item: Record<string, unknown>
	method: string
}

/** Where each operation with an `operationId` sits: its path item and method. */
function operationsById(doc: OpenApiDocument): Map<string, OperationSlot> {
	const byId = new Map<string, OperationSlot>()
	for (const item of Object.values(doc.paths ?? {})) {
		if (!isRecord(item)) continue
		for (const method of METHODS) {
			const op = item[method]
			if (isRecord(op) && typeof op.operationId === "string") byId.set(op.operationId, { item, method })
		}
	}
	return byId
}

function patchOperations(
	byId: ReadonlyMap<string, OperationSlot>,
	patches: Record<string, Record<string, unknown>>,
): void {
	for (const [operationId, patch] of Object.entries(patches)) {
		const at = byId.get(operationId)
		if (at === undefined)
			throw new UsageError(`overlay.operations["${operationId}"] names no operation in the document`)
		const renamed = patch.operationId
		if (typeof renamed === "string" && renamed !== operationId && byId.has(renamed)) {
			throw new UsageError(
				`overlay.operations["${operationId}"] renames it to "${renamed}", which another operation has`,
			)
		}
		at.item[at.method] = merge(at.item[at.method], patch)
	}
}

function patchSchemas(schemas: Record<string, unknown>, patches: Record<string, unknown>): void {
	for (const [name, patch] of Object.entries(patches)) {
		if (!Object.hasOwn(schemas, name)) {
			throw new UsageError(`overlay.schemas["${name}"] names no schema under components.schemas`)
		}
		schemas[name] = merge(schemas[name], patch)
	}
}
