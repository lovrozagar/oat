/**
 * A request built from an operation's own schema: its path parameters from the principal's roots,
 * a declared enum, `hooks.resolvePathValue` or an earlier success about the same kind of record; its
 * required query from `x-bind`, the document or an example; its body from the request schema. What
 * cannot be built leaves the operation untested with the reason.
 */

import { requestContent } from "../../spec/collection/request.ts"
import { scopingParams } from "../../spec/graph/roots.ts"
import { SAFE } from "../../spec/methods.ts"
import { applyActionBind } from "../effects/bind.ts"
import { buildCohort, type CohortMember } from "../fixture.ts"
import { nonexistentIdentity } from "../nonexistent-identity.ts"
import type { Exchange } from "../exchange.ts"
import type { GradeLedger } from "../grades.ts"
import { exampleOf, newestSeen, seenValue } from "./params.ts"
import type { ContractCall, ContractInput } from "./types.ts"

/*
 * Why `{name}` has no value, and what supplies one: a prefix root no create makes is the config's
 * (a principal's scope, or the hook); any other id comes from a response this run saw, or the hook.
 */
function unresolvedBecause(
	input: Pick<ContractInput, "client" | "model">,
	op: ContractCall["op"],
	name: string,
): string {
	if (refusedWrite(input, op, name)) return "a write is sent only to a record this run created"
	if (input.model.roots.includes(name) && scopingParams(op, input.model).includes(name))
		return "set it in the principal's scope, or answer it from hooks.resolvePathValue"
	return "no response this run saw carried one, and hooks.resolvePathValue did not answer"
}

/** Every path parameter's value, or `null` once one cannot be resolved (and the operation is skipped). */
export async function pathValues(
	input: Pick<ContractInput, "acting" | "client" | "grades" | "hooks" | "madeByRun" | "model" | "principal" | "roots">,
	{ op, params }: Pick<ContractCall, "op" | "params">,
): Promise<Record<string, string> | null> {
	const values: Record<string, string> = {}
	for (const name of op.pathParams) {
		const declared = params.find((param) => param.in === "path" && param.name === name)
		const value =
			input.roots[name] ??
			(declared?.schema?.enum === undefined ? undefined : exampleOf(declared.schema)) ??
			(await askHook(input, { declared, name, op })) ??
			seenFor(input, op, name)
		if (value === undefined || value === null) {
			input.grades.skipped([op.operationId], `unresolved param ${name}: ${unresolvedBecause(input, op, name)}`)
			return null
		}
		values[name] = value
	}
	return values
}

/* A path template with its parameter names dropped: `/projects/{project_id}/jobs` is `/projects/{}/jobs`. */
const shapeOf = (path: string): string => path.replaceAll(/\{[^}]*\}/g, "{}")

/* Where a parameter's records live: the collection's path shape, and one of its items'. */
interface Collection {
	path: string
	item: string
}

/* What a value is drawn from: the parameter's name, its collection, and the answers it may come from. */
interface Seen {
	name: string
	collection: Collection
	pool: readonly Exchange[]
}

/*
 * The value an earlier success returned under `name`. A bare record key (`id`, `uuid`, `slug`) names
 * the record of the body it sits in, so only an answer about the parameter's own collection holds
 * one: its list or create, or one of its items. Any other resource's newest record answers `id`
 * too, and is the wrong record. A qualified name (`thing_id`, `thingId`) names its entity, and any
 * answer's value under it will do. A read prefers a live record (`liveValue`); a write takes only a
 * record the run made (`madeValue`).
 */
function seenFor(
	input: Pick<ContractInput, "client" | "madeByRun" | "model">,
	op: ContractCall["op"],
	name: string,
): string | undefined {
	const seen = seenOf(input, op, name)
	/* A method that changes nothing may go to any record the run saw. */
	if (SAFE.has(op.method)) return liveValue(input, seen)
	return madeValue(input, seen)
}

/*
 * A read's value: a record the run has not deleted, else a deleted one. A read of a deleted record
 * can only answer 404, and a live one can answer what the document promises.
 */
function liveValue(input: Pick<ContractInput, "client" | "model">, seen: Seen): string | undefined {
	const { redactor } = input.client
	const gone = deletedIn(input, seen.collection)
	return (
		newestSeen(seen.pool, seen.name, (value) => !redactor.holdsSecret(value) && !gone.has(value)) ??
		seenValue(seen.pool, seen.name, redactor)
	)
}

/* Whether a write's parameter went unresolved though an answer showed a value: one the run did not make. */
function refusedWrite(input: Pick<ContractInput, "client" | "model">, op: ContractCall["op"], name: string): boolean {
	return !SAFE.has(op.method) && seenValue(seenOf(input, op, name).pool, name, input.client.redactor) !== undefined
}

/* The parameter's collection, and the answers its value may come from. */
function seenOf(input: Pick<ContractInput, "client" | "model">, op: ContractCall["op"], name: string): Seen {
	const { transcript } = input.client
	/* A built model's path parameters each stand in its path. */
	const at = op.path.indexOf(`{${name}}`)
	const path = shapeOf(op.path.slice(0, op.path.lastIndexOf("/", at)))
	const collection = { item: `${path}/{}`, path }
	const pool = /^[a-z0-9]+$/.test(name)
		? transcript.filter((exchange) => [path, collection.item].includes(shapeAt(input.model, exchange) ?? ""))
		: transcript
	return { collection, name, pool }
}

/* The path shape of the operation an exchange was sent to; none for a raw request or another document's. */
function shapeAt(model: ContractInput["model"], exchange: Exchange): string | undefined {
	const id = exchange.operationId
	const path = id === undefined ? undefined : model.byOperationId.get(id)?.path
	return path === undefined ? undefined : shapeOf(path)
}

/*
 * A write's value: a record this run made and has deleted since, where the write answers a harmless
 * 404, else a live one it made. Never one an answer merely showed: a list or a read shows records
 * the run did not make, and a write there would change one.
 */
function madeValue(input: Pick<ContractInput, "client" | "madeByRun" | "model">, seen: Seen): string | undefined {
	/* A route of no entity names records of none: nothing there is the run's. */
	const entity = input.model.operations.find((op) => shapeOf(op.path) === seen.collection.item)?.entity ?? undefined
	if (entity === undefined) return undefined
	const { redactor } = input.client
	const made = (value: string): boolean => !redactor.holdsSecret(value) && input.madeByRun(entity, value)
	const gone = deletedIn(input, seen.collection)
	return (
		newestSeen(seen.pool, seen.name, (value) => made(value) && gone.has(value)) ??
		newestSeen(seen.pool, seen.name, made)
	)
}

/* Every record of the collection a successful DELETE removed, by the id its URL ends in. */
function deletedIn(input: Pick<ContractInput, "client" | "model">, collection: Collection): Set<string> {
	const removed = input.client.transcript.filter(
		(exchange) =>
			exchange.method === "DELETE" &&
			exchange.status >= 200 &&
			exchange.status < 300 &&
			shapeAt(input.model, exchange) === collection.item,
	)
	return new Set(
		removed.map((exchange) => decodeURIComponent(new URL(exchange.url).pathname.split("/").at(-1) as string)),
	)
}

/* `hooks.resolvePathValue`, told who acts and what the operation would send as it: never raw headers. */
async function askHook(
	input: Pick<ContractInput, "acting" | "hooks" | "principal" | "roots">,
	asked: { op: ContractCall["op"]; name: string; declared: ContractCall["params"][number] | undefined },
): Promise<string | null | undefined> {
	const hook = input.hooks.resolvePathValue
	if (hook === undefined) return undefined
	const { op, name, declared } = asked
	const sending = await input.acting.sending(op.operationId)
	return hook({
		enumValues: (declared?.schema?.enum ?? []).map(String),
		identity: input.acting.identity,
		method: op.method,
		operationId: op.operationId,
		param: name,
		path: op.path,
		principal: input.principal,
		scope: input.roots,
		...sending,
	})
}

/**
 * Every required query parameter's value, or `null` once one cannot be resolved (and the operation
 * is skipped). What the operation names in `x-bind` is a value it accepts; a literal there beats a
 * guess. A pointer reads a record this call has none of, so it binds nothing here. A document's
 * object or array value stays whole: the client writes it in the parameter's style.
 */
export function queryValues(
	grades: GradeLedger,
	{ op, params, bind }: Pick<ContractCall, "bind" | "op" | "params">,
): Record<string, unknown> | null {
	const bound = applyActionBind(bind, { records: [], beforeBody: undefined }, undefined).query
	const query: Record<string, unknown> = {}
	for (const param of params) {
		if (param.in !== "query" || param.required !== true) continue
		/* A built model's query parameters are named: a nameless one fails the build. */
		const name = param.name as string
		const value = bound[name] ?? op.requiredQuery[name] ?? exampleOf(param.schema)
		if (value === undefined) {
			grades.skipped([op.operationId], `unresolved query param ${name}`)
			return null
		}
		query[name] = value
	}
	return query
}

/**
 * The request body, or `null` when the operation needs one oat cannot build (and is skipped). A
 * sign-in's fields that name the principal carry an identity no account holds: a generated value
 * can be a real account's (a documented `enum` of one admin address), and failed sign-ins count
 * toward its lockout.
 */
export function bodyOf(
	input: Pick<ContractInput, "credentials" | "grades" | "model" | "nonce" | "seed">,
	{ op, raw, bind }: Pick<ContractCall, "bind" | "op" | "raw">,
): { body: unknown } | null {
	const { model } = input
	const content = requestContent(raw)
	if (content === null) return { body: undefined }
	if (!content.mediaType.includes("json")) {
		input.grades.skipped([op.operationId], `needs a ${content.mediaType} body oat cannot build without a scenario`)
		return null
	}
	/* The schema `requestSchemaOf` reads, from the same raw operation. One variant asked for, one
	 * member back, and its body is always an object. */
	const [member] = buildCohort(content.schema, input.seed, {
		variants: ["baseline"],
		defs: model.defs,
		/* By operation, not by how many requests came before: the same run sends the same body. */
		nonce: `${input.nonce}c${op.operationId}`,
		operationId: op.operationId,
	}) as [CohortMember]
	const body = applyActionBind(bind, { records: [], beforeBody: undefined }, member.body).body
	const fields = input.credentials.identityFields.get(op.operationId) ?? []
	for (const path of fields) placeIdentity(body, { nonce: input.nonce, path, schema: content.schema })
	return { body }
}

/* The nonexistent identity at `path`, made where the generated body left the field out. */
function placeIdentity(body: unknown, at: { nonce: string; path: readonly string[]; schema: unknown }): void {
	const [name, ...rest] = at.path as [string, ...string[]]
	/* A dereferenced request schema; a field it does not declare has no schema to read. */
	const schema = (at.schema as { properties?: Record<string, unknown> }).properties?.[name]
	const record = body as Record<string, unknown>
	if (rest.length === 0) {
		record[name] = nonexistentIdentity({ name, schema }, at.nonce)
		return
	}
	const inner = record[name]
	if (inner === null || typeof inner !== "object" || Array.isArray(inner)) record[name] = {}
	placeIdentity(record[name], { nonce: at.nonce, path: rest, schema: schema ?? {} })
}
