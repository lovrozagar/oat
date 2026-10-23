/**
 * Response-schema validation — the floor beneath the behavioural checks.
 *
 * Schemas are compiled per operation+status and reused. `additionalProperties: false` is honoured
 * as written: a document that declares a closed object and a backend that returns extra fields
 * genuinely disagree, and which one is wrong is a decision for the reader, not for oat.
 */

import ajvModule from "ajv/dist/2020.js"
import formatsModule from "ajv-formats"
import { messageOf } from "../errors/message.ts"
import { DEFS_ID } from "../spec/load/defs.ts"
import { normalizeSchema } from "../spec/schema.ts"
import type { OperationObject, JsonSchema } from "../spec/types.ts"
import type { Exchange } from "./exchange.ts"

/**
 * Minimal surface oat uses — avoids depending on AJV's CJS/ESM type shape. `errors` is read only
 * after a call returned false, when AJV has set it, and with `messages` left on (the default)
 * every error carries its message.
 */
interface ValidateFunction {
	(data: unknown): boolean
	errors: Array<{ instancePath: string; message: string }>
}

interface AjvLike {
	compile: (schema: unknown) => ValidateFunction
	addSchema: (schema: unknown, key?: string) => unknown
}

type AjvConstructor = new (options: Record<string, unknown>) => AjvLike

export interface ValidationResult {
	ok: boolean
	errors: string[]
	/**
	 * Set when the documented schema could not be compiled, with AJV's reason. Nothing was
	 * validated, and the caller must say so — an uncompilable schema is not a passing one.
	 */
	unchecked?: string
}

const OK: ValidationResult = { errors: [], ok: true }

/* Both packages ship CJS whose `module.exports` is the callable itself, while their types put it on
 * `.default` under NodeNext resolution — hence the cast. */
const Ajv2020 = ajvModule as unknown as AjvConstructor
const addFormats = formatsModule as unknown as (ajv: AjvLike) => void

export class SchemaValidator {
	private readonly ajv: AjvLike
	private readonly cache = new Map<string, ValidateFunction | { failed: string } | null>()

	/** `defs`: the recursive schemas a dereferenced document refers to (see `dereference`). */
	constructor(defs: Record<string, JsonSchema> = {}) {
		this.ajv = new Ajv2020({
			allErrors: true,
			/* Specs in the wild carry annotations AJV does not know; refusing to compile over a
			 * vocabulary quibble would make oat useless on real documents. */
			strict: false,
			validateFormats: true,
		})
		addFormats(this.ajv)
		/* Recursive schemas are referenced as `oat-defs#/$defs/<name>`, so they are registered
		 * once under that id and every compiled schema can reach them. */
		const $defs: Record<string, JsonSchema> = {}
		for (const [name, def] of Object.entries(defs)) $defs[name] = normalizeSchema(def, { direction: "response" })
		this.ajv.addSchema({ $defs, $id: DEFS_ID })
	}

	/** Compiles the schema documented for this operation and status, if there is one. */
	private compile(op: OperationObject, key: string, status: number): ValidateFunction | { failed: string } | null {
		const cached = this.cache.get(key)
		if (cached !== undefined) return cached

		const schema = schemaFor(op, status)
		if (schema === null) {
			this.cache.set(key, null)
			return null
		}
		try {
			const validate = this.ajv.compile(normalizeSchema(schema, { direction: "response" }))
			this.cache.set(key, validate)
			return validate
		} catch (error) {
			/* An uncompilable schema is a spec defect, surfaced by the caller as a gap rather than
			 * crashing the run — and never as a pass. */
			const failed = { failed: messageOf(error) }
			this.cache.set(key, failed)
			return failed
		}
	}

	/** Whether `response` holds to the schema `op` documents for its status. */
	validate(
		operationId: string,
		op: OperationObject,
		response: Pick<Exchange, "responseBody" | "status">,
	): ValidationResult {
		const { status } = response
		const validate = this.compile(op, `${operationId}:${status}`, status)
		if (validate === null) return OK
		if ("failed" in validate) return { errors: [], ok: true, unchecked: validate.failed }
		if (validate(response.responseBody) === true) return OK
		const errors = validate.errors.map((error) => `${error.instancePath || "(root)"} ${error.message}`)
		return { errors: [...new Set(errors)].slice(0, 12), ok: false }
	}

	/** True when the document actually documents this status for this operation. */
	documents(op: OperationObject, status: number): boolean {
		return schemaFor(op, status) !== null
	}

	/**
	 * True when the response the document gives this status — exact, its range, else `default` —
	 * declares no body: a 201 that names the record only in `Location`, say.
	 */
	documentsNoBody(op: OperationObject, status: number): boolean {
		const responses = op.responses ?? {}
		const code = responseKeys(status).find((key) => responses[key] !== undefined)
		return code !== undefined && Object.keys(responses[code]?.content ?? {}).length === 0
	}
}

/* The response keys a status falls under, most specific first. */
function responseKeys(status: number): string[] {
	return [String(status), `${Math.floor(status / 100)}XX`, "default"]
}

function schemaFor(op: OperationObject, status: number): JsonSchema | null {
	const responses = op.responses ?? {}
	for (const code of responseKeys(status)) {
		const content = responses[code]?.content
		if (content === undefined) continue
		for (const [mediaType, media] of Object.entries(content)) {
			if (mediaType.includes("json") && media.schema !== undefined) return media.schema
		}
	}
	return null
}

/* One AJV per set of definitions: each registers them under `oat-defs`, as the document names them. */
// per-process-constant: compiled-schema
const instanceAjvs = /* @__PURE__ */ new WeakMap<object, AjvLike>()
const NO_DEFS: Record<string, JsonSchema> = {}
// per-process-constant: compiled-schema
const instanceCache = /* @__PURE__ */ new WeakMap<object, ValidateFunction | { failed: string }>()

function ajvFor(defs: Record<string, JsonSchema>): AjvLike {
	const existing = instanceAjvs.get(defs)
	if (existing !== undefined) return existing
	const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
	addFormats(ajv)
	const $defs: Record<string, JsonSchema> = {}
	for (const [name, def] of Object.entries(defs)) $defs[name] = normalizeSchema(def, { direction: "request" })
	ajv.addSchema({ $defs, $id: DEFS_ID })
	instanceAjvs.set(defs, ajv)
	return ajv
}

/**
 * Whether `value` satisfies an already-normalized `schema` — the self-check every generated body
 * passes before it is sent. Returns AJV's complaints, or `[]`.
 */
export function instanceErrors(
	schema: JsonSchema,
	value: unknown,
	defs: Record<string, JsonSchema> = NO_DEFS,
): string[] {
	let compiled = instanceCache.get(schema)
	if (compiled === undefined) {
		try {
			compiled = ajvFor(defs).compile(schema)
		} catch (error) {
			compiled = { failed: messageOf(error) }
		}
		instanceCache.set(schema, compiled)
	}
	if ("failed" in compiled) return [`schema cannot be compiled: ${compiled.failed}`]
	if (compiled(value) === true) return []
	return compiled.errors.map((error) => `${error.instancePath || "(root)"} ${error.message}`)
}
