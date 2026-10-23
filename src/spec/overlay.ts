/**
 * Patches to a document the tester cannot change, applied from config before anything reads it.
 *
 * An operation is addressed as `ops` and `allow` address one: by its `operationId`, or as
 * `METHOD /path` when the document gives it none. A schema is addressed by its name under
 * `components.schemas`. Objects merge, arrays replace, and `null` deletes the key, so a patch can
 * add a tag, fix a constraint or restate a parameter list without copying the rest. A patch that
 * names nothing is a mistake in the config, and stops the run before it starts; so are two patches
 * that name one operation (`GET /a` and `get /a`), since neither order is the obvious one.
 *
 * Security is the exception to naming: `securitySchemes` may add a scheme the document never
 * declared, since declaring one is its purpose, and `security` replaces the root requirement.
 */

import { didYouMean } from "../errors/suggest.ts"
import { UsageError } from "../errors/usage-error.ts"
import type { SpecOverlay } from "../config/types/config.ts"
import { type OperationSlot, operationSlots, resolveOperationName } from "./operation-name.ts"
import type { OpenApiDocument } from "./types.ts"

export type { SpecOverlay } from "../config/types/config.ts"

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
	if (overlay.securitySchemes !== undefined) {
		const securitySchemes = merge(out.components?.securitySchemes ?? {}, overlay.securitySchemes)
		out.components = { ...out.components, securitySchemes: securitySchemes as Record<string, unknown> }
	}
	if (overlay.security !== undefined) out.security = structuredClone(overlay.security)
	patchOperations(operationSlots((out.paths ?? {}) as Record<string, unknown>), overlay.operations ?? {})
	patchSchemas((out.components?.schemas ?? {}) as Record<string, unknown>, overlay.schemas ?? {})
	return out
}

/** Each patch merged into the operation its key names, as the document named it before any patch. */
function patchOperations(
	slots: ReadonlyMap<string, OperationSlot>,
	patches: Record<string, Record<string, unknown>>,
): void {
	const keyOf = new Map<string, string>()
	for (const [key, patch] of Object.entries(patches)) {
		const name = resolveOperationName(key, slots)
		if (name === undefined) {
			throw new UsageError(`overlay.operations "${key}" matches no operation.${didYouMean(key, slots.keys())}`)
		}
		const earlier = keyOf.get(name)
		if (earlier !== undefined) {
			throw new UsageError(`overlay.operations "${earlier}" and "${key}" name the same operation`)
		}
		keyOf.set(name, key)
		const renamed = patch["operationId"]
		if (typeof renamed === "string" && renamed !== name && slots.has(renamed)) {
			throw new UsageError(`overlay.operations "${key}" renames it to "${renamed}", which another operation has`)
		}
		const at = slots.get(name) as OperationSlot
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
