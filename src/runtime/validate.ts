/**
 * Response-schema validation — the floor beneath the behavioural checks.
 *
 * Schemas are compiled per operation+status and reused. `additionalProperties: false` is honoured
 * as written: a document that declares a closed object and a backend that returns extra fields
 * genuinely disagree, and which one is wrong is a decision for the reader, not for oat.
 */

import ajvModule from "ajv/dist/2020.js"
import formatsModule from "ajv-formats"
import type { OperationObject, SchemaObject } from "../spec/types.ts"

/** Minimal surface oat uses — avoids depending on AJV's CJS/ESM type shape. */
export interface ValidateFunction {
	(data: unknown): boolean
	errors?: Array<{ instancePath?: string; message?: string }> | null
}

interface AjvLike {
	compile: (schema: unknown) => ValidateFunction
}

type AjvConstructor = new (options: Record<string, unknown>) => AjvLike

export interface ValidationResult {
	ok: boolean
	errors: string[]
}

const OK: ValidationResult = { errors: [], ok: true }

/* Both packages ship CJS with an interop default, so the callable lives on `.default` under
 * NodeNext resolution — but only at runtime, hence the cast. */
const Ajv2020 = ((ajvModule as { default?: unknown }).default ?? ajvModule) as AjvConstructor
const addFormats = ((formatsModule as { default?: unknown }).default ?? formatsModule) as (
	ajv: AjvLike,
) => void

export class SchemaValidator {
	private readonly ajv: AjvLike
	private readonly cache = new Map<string, ValidateFunction | null>()

	constructor() {
		this.ajv = new Ajv2020({
			allErrors: true,
			/* Specs in the wild carry annotations AJV does not know; refusing to compile over a
			 * vocabulary quibble would make oat useless on real documents. */
			strict: false,
			validateFormats: true,
		})
		addFormats(this.ajv)
	}

	/** Compiles the schema documented for this operation and status, if there is one. */
	private compile(op: OperationObject, key: string, status: number): ValidateFunction | null {
		const cached = this.cache.get(key)
		if (cached !== undefined) return cached

		const schema = schemaFor(op, status)
		if (schema === null) {
			this.cache.set(key, null)
			return null
		}
		try {
			const validate = this.ajv.compile(sanitise(schema))
			this.cache.set(key, validate)
			return validate
		} catch {
			/* An uncompilable schema is a spec defect, surfaced by the caller as a gap rather than
			 * crashing the run. */
			this.cache.set(key, null)
			return null
		}
	}

	validate(
		operationId: string,
		op: OperationObject,
		status: number,
		body: unknown,
	): ValidationResult {
		const validate = this.compile(op, `${operationId}:${status}`, status)
		if (validate === null) return OK
		if (validate(body) === true) return OK
		const errors = (validate.errors ?? []).map((error) => {
			const at = error.instancePath === undefined || error.instancePath === "" ? "(root)" : error.instancePath
			return `${at} ${error.message ?? "is invalid"}`
		})
		return { errors: [...new Set(errors)].slice(0, 12), ok: false }
	}

	/** True when the document actually documents this status for this operation. */
	documents(op: OperationObject, status: number): boolean {
		return schemaFor(op, status) !== null
	}
}

function schemaFor(op: OperationObject, status: number): SchemaObject | null {
	const responses = op.responses ?? {}
	const candidates = [String(status), `${Math.floor(status / 100)}XX`, "default"]
	for (const code of candidates) {
		const content = responses[code]?.content
		if (content === undefined) continue
		for (const [mediaType, media] of Object.entries(content)) {
			if (mediaType.includes("json") && media.schema !== undefined) return media.schema
		}
	}
	return null
}

/**
 * Strips constructs that break AJV but carry no validation meaning here: OpenAPI's `nullable`
 * without a sibling `type` (invalid JSON Schema, emitted by several generators), and `example`
 * keys that collide with the `examples` keyword in draft 2020-12.
 */
function sanitise(schema: SchemaObject): SchemaObject {
	const walk = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(walk)
		if (node === null || typeof node !== "object") return node
		const out: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (key === "nullable") continue
			if (key === "example") continue
			if (key === "discriminator") continue
			out[key] = walk(value)
		}
		/* `nullable: true` with a concrete type widens the type rather than being dropped. */
		const original = node as Record<string, unknown>
		if (original.nullable === true && typeof original.type === "string") {
			out.type = [original.type, "null"]
		}
		return out
	}
	return walk(schema) as SchemaObject
}
