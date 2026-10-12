/**
 * `x-entity.identity: self` — the signed-up caller is the record.
 * There is no list. A create, when the spec has one, runs before the read and the read
 * must show a value from that create. An update is still there on the next read.
 * No token is a 401.
 */

import type { EntityModel, OperationModel, SpecModel } from "../spec/graph.ts"
import type { Hooks } from "../config/define-config.ts"
import type { CheckContext, WriteContext } from "./checks.ts"
import { requestContentOf } from "./body.ts"
import type { Client, Exchange } from "./client.ts"
import { ASSERTED, type FindingCollector, type Outcome } from "./finding.ts"
import { buildCohort, isOverflowError } from "./fixture.ts"
import { applyResolveInput } from "./input.ts"
import { fillPath, requestSchemaOf } from "./world.ts"
import type { CheckId } from "./check-ids.ts"

export const SELF_IDENTITY = "self"
export const SELF_CHECK_ID = "auth.self-is-the-caller" as const satisfies CheckId

const PREFERRED_FIELDS = ["first_name", "display_name", "name", "nickname"]

export function selfReadIds(entity: EntityModel): string[] {
	if (entity.reads !== undefined && entity.reads.length > 0) return entity.reads
	return entity.read === undefined ? [] : [entity.read]
}

/** GET actions with no path id, such as a handle query on the caller. */
export function selfActionIds(entity: EntityModel, model: SpecModel): string[] {
	if (entity.identity !== SELF_IDENTITY) return []
	return entity.actions.filter((id) => {
		const op = model.byOperationId.get(id)
		return op !== undefined && op.method.toUpperCase() === "GET" && op.pathParams.length === 0
	})
}

export function selfOperationIds(entity: EntityModel, model?: SpecModel): string[] {
	if (entity.identity !== SELF_IDENTITY) return []
	const ids = [...selfReadIds(entity), entity.update].filter((id): id is string => id !== undefined)
	const actions = model === undefined ? [] : selfActionIds(entity, model)
	const withCreate = ids.length === 0 || entity.create === undefined ? ids : [entity.create, ...ids]
	return [...withCreate, ...actions]
}

export function entityIsSelf(entity: EntityModel): boolean {
	return selfOperationIds(entity).length > 0
}

interface ProbeField {
	kind: "boolean" | "string"
	maxLength: number
	name: string
}

function asSchema(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null
	return value as Record<string, unknown>
}

/** A nullable union is the non-null branch. `type: ["string", "null"]` is a string. */
function unwrap(schema: Record<string, unknown>): Record<string, unknown> {
	const branches = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null
	if (branches !== null) {
		const nonNull = branches
			.map(asSchema)
			.filter((branch): branch is Record<string, unknown> => branch !== null && branch.type !== "null")
		const only = nonNull.length === 1 ? nonNull[0] : undefined
		if (only !== undefined) return unwrap(only)
	}
	if (Array.isArray(schema.type)) {
		const types = schema.type.filter((type) => type !== "null")
		if (types.length === 1) return { ...schema, type: types[0] }
	}
	return schema
}

function probeField(schema: unknown): ProbeField | null {
	const root = asSchema(schema)
	if (root === null) return null
	const properties = unwrap(root).properties
	if (properties === null || typeof properties !== "object") return null
	const record = properties as Record<string, unknown>
	const names = [
		...PREFERRED_FIELDS.filter((name) => record[name] !== undefined),
		...Object.keys(record).filter((name) => !PREFERRED_FIELDS.includes(name)),
	]
	let boolean: ProbeField | null = null
	for (const name of names) {
		const raw = asSchema(record[name])
		if (raw === null) continue
		const rec = unwrap(raw)
		if (rec.readOnly === true) continue
		if (rec.type === "boolean") {
			boolean ??= { kind: "boolean", maxLength: 0, name }
			continue
		}
		if (rec.type !== "string") continue
		if (Array.isArray(rec.enum)) continue
		if (rec.format === "email" || rec.format === "uri" || rec.format === "date-time") continue
		if (typeof rec.pattern === "string") continue
		const maxLength = typeof rec.maxLength === "number" ? rec.maxLength : 64
		if (maxLength < 4) continue
		return { kind: "string", maxLength, name }
	}
	return boolean
}

function nextValue(field: ProbeField, current: unknown): boolean | string {
	if (field.kind === "boolean") return current !== true
	const primary = "Oat".slice(0, field.maxLength)
	const alternate = "Xot".slice(0, field.maxLength)
	return current === primary ? alternate : primary
}

function operation(model: SpecModel, id: string | undefined): OperationModel | undefined {
	return id === undefined ? undefined : model.byOperationId.get(id)
}

function pathOf(op: OperationModel): string | null {
	try {
		return fillPath(op.path, {})
	} catch {
		return null
	}
}

export async function runSelfIdentity(input: {
	auth: () => Record<string, string>
	client: Client
	entity: EntityModel
	findings: FindingCollector
	model: SpecModel
	nonce?: string
	resolveInput?: Hooks["resolveInput"]
	seed?: number
}): Promise<Outcome> {
	const readOp = operation(input.model, input.entity.read)
	const updateOp = operation(input.model, input.entity.update)
	const ops = selfOperationIds(input.entity, input.model)
	const findings = input.findings.attributed(ops).ownedBy(SELF_CHECK_ID)
	const probe = readOp ?? updateOp
	if (probe === undefined) return findings.unresolved(SELF_CHECK_ID, input.entity.name, "no read or update")
	const probePath = pathOf(probe)
	if (probePath === null) {
		return findings.unresolved(SELF_CHECK_ID, input.entity.name, `${probe.operationId} needs a path id`)
	}

	const anonymous = await input.client.request(probe.method, probePath, {
		headers: {},
		operationId: probe.operationId,
		skipAuthRefresh: true,
	})
	if (anonymous.status !== 401) {
		return findings.security(
			SELF_CHECK_ID,
			input.entity.name,
			"the caller route answered without a token",
			`${probe.operationId} returned ${anonymous.status} with no credential. The signed-up caller is the record, so no token is a 401.`,
			[anonymous],
		)
	}

	const readIds = selfReadIds(input.entity)
	const readOps = readIds.map((id) => operation(input.model, id)).filter((op): op is OperationModel => op !== undefined)
	if (readOps.length === 0 && readOp === undefined) {
		const updatePath = pathOf(updateOp as OperationModel)
		if (updatePath === null || updateOp === undefined) return ASSERTED
		const wrote = await sendUpdate(input.client, updateOp, updatePath, input.auth, { note: "Oat" })
		if (wrote.status === 429) return throttled(findings, input.entity.name)
		if (wrote.status < 200 || wrote.status >= 300) {
			return findings.backend(
				SELF_CHECK_ID,
				input.entity.name,
				"updating the caller failed",
				`${updateOp.operationId} returned ${wrote.status} for the signed-up caller.`,
				[anonymous, wrote],
			)
		}
		return ASSERTED
	}

	const created = await createCaller(input, findings)
	if (created !== null && "kind" in created) return created

	const reads: Exchange[] = []
	for (const op of readOps) {
		const readPath = pathOf(op)
		if (readPath === null) {
			return findings.unresolved(SELF_CHECK_ID, input.entity.name, `${op.operationId} needs a path id`)
		}
		const read = await input.client.request(op.method, readPath, {
			headers: input.auth,
			operationId: op.operationId,
		})
		if (read.status === 429) return throttled(findings, input.entity.name)
		if (read.status !== 200) {
			return findings.backend(
				SELF_CHECK_ID,
				input.entity.name,
				"reading the caller failed",
				`${op.operationId} returned ${read.status} for the signed-up caller. The read is that caller and returns 200.`,
				[anonymous, read],
			)
		}
		reads.push(read)
	}
	const read = reads[0]
	if (read === undefined || readOp === undefined) return ASSERTED
	if (created !== null && !callerEchoed(created.body, read.responseBody)) {
		return findings.backend(
			SELF_CHECK_ID,
			input.entity.name,
			"the create did not show up on the next read",
			`${created.exchange.operationId} sent ${JSON.stringify(created.body)}, and the next ${readOp.operationId} returned ${JSON.stringify(read.responseBody)}.`,
			[created.exchange, read],
		)
	}

	const acted = await runSelfActions(input, findings, created === null ? null : created.body)
	if (acted !== null) return acted

	if (updateOp === undefined) return ASSERTED
	const updatePath = pathOf(updateOp)
	if (updatePath === null) return ASSERTED
	const content = requestContentOf(updateOp, input.model)
	const field = probeField(content?.schema)
	if (field === null) {
		return findings.unresolved(
			SELF_CHECK_ID,
			input.entity.name,
			"the update has no plain string or boolean field to change",
		)
	}
	const before = locateProbe(read.responseBody, field.name)
	const current = before.current
	const value = nextValue(field, current)
	const wrote = await sendUpdate(input.client, updateOp, updatePath, input.auth, { [field.name]: value })
	if (wrote.status === 429) return throttled(findings, input.entity.name)
	if (wrote.status < 200 || wrote.status >= 300) {
		return findings.backend(
			SELF_CHECK_ID,
			input.entity.name,
			"updating the caller failed",
			`${updateOp.operationId} returned ${wrote.status} when setting ${field.name}.`,
			[read, wrote],
		)
	}
	const againPath = pathOf(readOp)
	if (againPath === null) return findings.unresolved(SELF_CHECK_ID, input.entity.name, "the read needs a path id")
	const again = await input.client.request(readOp.method, againPath, {
		headers: input.auth,
		operationId: readOp.operationId,
	})
	if (again.status === 429) return throttled(findings, input.entity.name)
	const after = locateProbe(again.responseBody, field.name)
	if (again.status !== 200 || !probeStuck(before, after, value)) {
		return findings.backend(
			SELF_CHECK_ID,
			input.entity.name,
			"an update to the caller did not stick",
			`${updateOp.operationId} set ${field.name} to ${JSON.stringify(value)}, and the next ${readOp.operationId} returned ${again.status} with ${JSON.stringify(after.where === "top" ? after.current : after.values)}.`,
			[wrote, again],
		)
	}
	if (typeof current === "string" || current === null || typeof current === "boolean") {
		await sendUpdate(input.client, updateOp, updatePath, input.auth, { [field.name]: current })
	}
	return ASSERTED
}

/** A 429 that outlived the client's retries is the bucket, not the caller routes: nothing was shown. */
function throttled(findings: FindingCollector, entity: string): Outcome {
	return findings.unresolved(
		SELF_CHECK_ID,
		entity,
		"the request was rate-limited (429) after retries, so this check could not complete",
	)
}

interface CreatedCaller {
	body: Record<string, unknown>
	exchange: Exchange
}

/** Optional fields stay out. A create that pairs them (a label without its url) is a different check. */
function requiredSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const required = Array.isArray(schema.required)
		? schema.required.filter((name): name is string => typeof name === "string")
		: []
	if (required.length === 0) return schema
	const properties = schema.properties
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return schema
	const source = properties as Record<string, unknown>
	const picked: Record<string, unknown> = {}
	for (const name of required) if (name in source) picked[name] = source[name]
	return { ...schema, properties: picked, required }
}

function propertyNames(schema: Record<string, unknown>): Set<string> {
	const properties = schema.properties
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return new Set()
	return new Set(Object.keys(properties as Record<string, unknown>))
}

interface LocatedProbe {
	current: unknown
	values: unknown[]
	where: "missing" | "nested" | "top"
}

/** Top-level field, or the same field on each nested object when the read is a map of records. */
function locateProbe(body: unknown, field: string): LocatedProbe {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return { current: undefined, values: [], where: "missing" }
	}
	const record = body as Record<string, unknown>
	if (Object.prototype.hasOwnProperty.call(record, field)) {
		return { current: record[field], values: [record[field]], where: "top" }
	}
	const values: unknown[] = []
	for (const value of Object.values(record)) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) continue
		const child = value as Record<string, unknown>
		if (Object.prototype.hasOwnProperty.call(child, field)) values.push(child[field])
	}
	if (values.length === 0) return { current: undefined, values: [], where: "missing" }
	return { current: values[0], values, where: "nested" }
}

function probeStuck(before: LocatedProbe, after: LocatedProbe, value: unknown): boolean {
	if (before.where === "nested") {
		return (
			after.where === "nested" &&
			after.values.includes(value) &&
			JSON.stringify(after.values) !== JSON.stringify(before.values)
		)
	}
	return after.current === value
}

function callerEchoed(sent: Record<string, unknown>, body: unknown): boolean {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return false
	const record = body as Record<string, unknown>
	return Object.entries(sent).some(([key, value]) => {
		if (value === null || typeof value === "object") return false
		return record[key] === value
	})
}

/** POST the spec's create. `null` when this caller record already exists. */
async function createCaller(
	input: {
		auth: () => Record<string, string>
		client: Client
		entity: EntityModel
		model: SpecModel
		nonce?: string
		resolveInput?: Hooks["resolveInput"]
		seed?: number
	},
	findings: FindingCollector,
): Promise<CreatedCaller | Outcome | null> {
	const createOp = operation(input.model, input.entity.create)
	if (createOp === undefined) return null
	const createPath = pathOf(createOp)
	if (createPath === null) {
		return findings.unresolved(SELF_CHECK_ID, input.entity.name, `${createOp.operationId} needs a path id`)
	}
	const schema = requestSchemaOf(createOp, input.model)
	if (schema === null) {
		return findings.unresolved(SELF_CHECK_ID, input.entity.name, `${createOp.operationId} declares no request body`)
	}
	let body: Record<string, unknown>
	const required = requiredSchema(schema)
	try {
		const [member] = buildCohort(required, input.seed ?? 1, ["baseline"], createOp.operationId, {
			distinct: propertyNames(required),
			...(input.nonce === undefined ? {} : { nonce: input.nonce }),
		})
		body = member?.body ?? {}
	} catch (error) {
		if (!isOverflowError(error)) throw error
		return findings.unresolved(
			SELF_CHECK_ID,
			input.entity.name,
			error instanceof Error ? error.message : `${createOp.operationId} body could not be generated`,
		)
	}
	if (input.resolveInput !== undefined) {
		body = await applyResolveInput(body, createOp.operationId, schema, input.resolveInput)
	}
	const exchange = await input.client.request(createOp.method, createPath, {
		body,
		headers: input.auth,
		operationId: createOp.operationId,
	})
	if (exchange.status < 200 || exchange.status >= 300) {
		return findings.backend(
			SELF_CHECK_ID,
			input.entity.name,
			"creating the caller failed",
			`${createOp.operationId} returned ${exchange.status} for the signed-up caller.`,
			[exchange],
		)
	}
	return { body, exchange }
}

async function runSelfActions(
	input: {
		auth: () => Record<string, string>
		client: Client
		entity: EntityModel
		model: SpecModel
	},
	findings: FindingCollector,
	created: Record<string, unknown> | null,
): Promise<Outcome | null> {
	for (const id of selfActionIds(input.entity, input.model)) {
		const op = operation(input.model, id)
		if (op === undefined) continue
		const query: Record<string, string> = {}
		for (const name of op.queryParamNames) {
			const value = created?.[name]
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
				query[name] = String(value)
			}
		}
		const missing = op.queryParamNames.filter((name) => query[name] === undefined)
		if (missing.length > 0) {
			return findings.unresolved(
				SELF_CHECK_ID,
				input.entity.name,
				`${op.operationId} needs ${missing.join(", ")} and the create did not send it`,
			)
		}
		const response = await input.client.request(op.method, op.path, {
			headers: input.auth,
			operationId: op.operationId,
			query,
		})
		if (response.status !== 200) {
			return findings.backend(
				SELF_CHECK_ID,
				input.entity.name,
				"the caller query failed",
				`${op.operationId} returned ${response.status} for ${JSON.stringify(query)}.`,
				[response],
			)
		}
		if (response.responseBody !== null && typeof response.responseBody === "object") {
			const record = response.responseBody as Record<string, unknown>
			for (const [name, value] of Object.entries(query)) {
				if (Object.prototype.hasOwnProperty.call(record, name) && String(record[name]) !== value) {
					return findings.backend(
						SELF_CHECK_ID,
						input.entity.name,
						"the caller query answered about a different value",
						`${op.operationId} was asked for ${name}=${value} and returned ${JSON.stringify(record[name])}.`,
						[response],
					)
				}
			}
		}
	}
	return null
}

async function sendUpdate(
	client: Client,
	op: OperationModel,
	path: string,
	auth: () => Record<string, string>,
	body: Record<string, unknown>,
): Promise<Exchange> {
	return client.request(op.method, path, {
		body,
		headers: auth,
		operationId: op.operationId,
	})
}

export const selfIdentityCheck = {
	id: SELF_CHECK_ID,
	mutates: true as const,
	needs: "x-entity.identity: self, and a read or an update",
	plan(ctx: CheckContext) {
		const entity = ctx.model.entities.get(ctx.entityName)
		if (entity === undefined || !entityIsSelf(entity)) {
			return { ok: false as const, needs: "x-entity.identity: self, and a read or an update" }
		}
		return { ok: true as const, value: undefined }
	},
	async run(ctx: WriteContext): Promise<Outcome> {
		return runSelfIdentity({
			auth: ctx.auth,
			client: ctx.client,
			entity: ctx.model.entities.get(ctx.entityName) as EntityModel,
			findings: ctx.findings,
			model: ctx.model,
		})
	},
	subjects: (entity: EntityModel, model?: SpecModel): string[] => selfOperationIds(entity, model),
}
