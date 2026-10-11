/**
 * `x-entity.identity: self` — the signed-up caller is the record.
 * There is no list and no create. A read returns that caller. An update is still there
 * on the next read. No token is a 401.
 */

import type { EntityModel, OperationModel, SpecModel } from "../spec/graph.ts"
import type { CheckContext, WriteContext } from "./checks.ts"
import { requestContentOf } from "./body.ts"
import type { Client, Exchange } from "./client.ts"
import { ASSERTED, type FindingCollector, type Outcome } from "./finding.ts"
import { fillPath } from "./world.ts"
import type { CheckId } from "./check-ids.ts"

export const SELF_IDENTITY = "self"
export const SELF_CHECK_ID = "auth.self-is-the-caller" as const satisfies CheckId

const PREFERRED_FIELDS = ["first_name", "display_name", "name", "nickname"]

export function selfReadIds(entity: EntityModel): string[] {
	if (entity.reads !== undefined && entity.reads.length > 0) return entity.reads
	return entity.read === undefined ? [] : [entity.read]
}

export function selfOperationIds(entity: EntityModel): string[] {
	if (entity.identity !== SELF_IDENTITY) return []
	return [...selfReadIds(entity), entity.update].filter((id): id is string => id !== undefined)
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
}): Promise<Outcome> {
	const readOp = operation(input.model, input.entity.read)
	const updateOp = operation(input.model, input.entity.update)
	const ops = selfOperationIds(input.entity)
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
	const before = read.responseBody
	const current =
		before !== null && typeof before === "object" ? (before as Record<string, unknown>)[field.name] : undefined
	const value = nextValue(field, current)
	const wrote = await sendUpdate(input.client, updateOp, updatePath, input.auth, { [field.name]: value })
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
	const seen =
		again.responseBody !== null && typeof again.responseBody === "object"
			? (again.responseBody as Record<string, unknown>)[field.name]
			: undefined
	if (again.status !== 200 || seen !== value) {
		return findings.backend(
			SELF_CHECK_ID,
			input.entity.name,
			"an update to the caller did not stick",
			`${updateOp.operationId} set ${field.name} to ${JSON.stringify(value)}, and the next ${readOp.operationId} returned ${again.status} with ${JSON.stringify(seen)}.`,
			[wrote, again],
		)
	}
	if (typeof current === "string" || current === null || typeof current === "boolean") {
		await sendUpdate(input.client, updateOp, updatePath, input.auth, { [field.name]: current })
	}
	return ASSERTED
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
	subjects: (entity: EntityModel): string[] => selfOperationIds(entity),
}
