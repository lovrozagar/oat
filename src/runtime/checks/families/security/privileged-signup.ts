/*
 * The sign-up side of auth.privileged-field-ignored. Anyone may sign up, so a sign-up must not make
 * an account holding a property only the highest rank may set. oat signs one account up through the
 * document's sign-up (the operation marked x-fresh-principal, or one it leaves unmarked): a body
 * generated from its schema, each marked property set to the value that grants the privilege. Then
 * it reads back whether that took, by the first read that shows it: the account's own read, the
 * listing of the entity the sign-up makes, or the property in the sign-up's own answer. With none
 * that could show it, nothing is sent. The sign-up goes through the client, so the run's ledger names
 * the account before it goes, and teardown removes it as it removes any account the run made, or
 * names it a leftover.
 */

import { isDeepStrictEqual } from "node:util"
import { messageOf } from "../../../../errors/message.ts"
import { requestSchema } from "../../../../spec/collection/request.ts"
import { successSchema } from "../../../../spec/collection/responses.ts"
import { propertySchema } from "../../../../spec/extensions/privileged.ts"
import type { OperationModel, SpecModel } from "../../../../spec/graph/types.ts"
import type { JsonSchema, OperationObject } from "../../../../spec/types.ts"
import { accountIdentity } from "../../../accounts/identity.ts"
import { unmarkedSignUp } from "../../../accounts/unmarked.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { buildCohort, type CohortMember } from "../../../fixture.ts"
import { SELF_IDENTITY, selfReadIds } from "../../../self/operations.ts"
import { recordOf, recordsFromList } from "../../../world/records.ts"
import type { Actor } from "../../core/context.ts"
import type { OperationContext, OperationWriteContext, Probed } from "../../core/operation-context.ts"
import { andThen, cannot, type Plan, ready } from "../../core/plan.ts"

type Fields = Record<string, unknown>

const CHECK = "auth.privileged-field-ignored"

/** A read that shows the account the sign-up made, and how it is sent. */
export type ReadBack =
	/** The account's own read, sent as the account. */
	| { kind: "self"; op: OperationModel }
	/** The listing of the entity the sign-up makes, sent as `as`; the account's row is the one `identity` names. */
	| { kind: "listing"; op: OperationModel; as: Actor; path: string; identity: Record<string, string> }
	/** The sign-up's own answer. */
	| { kind: "answer" }

/** The body the sign-up sends, each marked property with the value it is set to, and the reads that show it. */
export interface SignUpProbe {
	kind: "signup"
	body: Fields
	values: ReadonlyArray<[path: string, value: unknown]>
	reads: readonly ReadBack[]
}

/** Whether the operation signs an account up: marked x-fresh-principal, or a sign-up the document leaves unmarked. */
export function isSignUp(ctx: Pick<OperationContext, "model" | "operation">): boolean {
	return ctx.operation.freshPrincipal || unmarkedSignUp(ctx.operation, ctx.model)
}

/** What the sign-up probe sends and reads; a stand-down naming what is missing, before anything is sent. */
export function signUpPlan(ctx: OperationContext): Plan<SignUpProbe> {
	/* The model holds every operation it lists; a marked property implies a request body. */
	const raw = ctx.model.rawOperations.get(ctx.operation.operationId) as OperationObject
	const schema = requestSchema(raw) as JsonSchema
	return andThen(valuesOf(ctx, schema), (values) =>
		andThen(bodyOf(ctx, { schema, values }), (body) => {
			const reads = readBacks(ctx, { body, paths: values.map(([path]) => path), raw })
			if (reads.length > 0) return ready({ body, kind: "signup", reads, values })
			return cannot(
				`a read that shows ${values.map(([path]) => path).join(", ")} of the account ${ctx.operation.operationId} ` +
					"makes: the account's own read (x-entity identity self), a listing of the entity it makes, or its own answer",
			)
		}),
	)
}

/*
 * The value each marked property is set to: its `const`, its enum's one member, or `true` for a
 * boolean. Any other property says nothing of which value is privileged, and oat never guesses one.
 */
function valuesOf(ctx: OperationContext, schema: JsonSchema): Plan<Array<[string, unknown]>> {
	const values: Array<[string, unknown]> = []
	for (const path of ctx.operation.privileged) {
		const property = propertySchema(schema, path)
		if (property !== undefined && Object.hasOwn(property, "const")) values.push([path, property.const])
		else if (Array.isArray(property?.enum) && property.enum.length === 1) values.push([path, property.enum[0]])
		else if (property?.type === "boolean") values.push([path, true])
		else return cannot(`${path}: no value oat can tell is privileged (no const, no one-member enum, not a boolean)`)
	}
	return ready(values)
}

/* One baseline member of the sign-up's schema, under the run's seed and a nonce of its own, with each value set. */
function bodyOf(
	ctx: OperationContext,
	{ schema, values }: { schema: JsonSchema; values: ReadonlyArray<[string, unknown]> },
): Plan<Fields> {
	const { operationId } = ctx.operation
	let body: Fields
	try {
		/* One variant asked for, one member back, and its body is always an object. */
		const [member] = buildCohort(schema, ctx.seed, {
			defs: ctx.model.defs,
			nonce: `${ctx.nonce}privileged`,
			operationId,
			variants: ["baseline"],
		}) as [CohortMember]
		body = member.body
	} catch (error) {
		/* A schema no body satisfies: buildCohort throws a FixtureOverflow naming why. */
		return cannot(`a valid sign-up body for ${operationId}: ${messageOf(error)}`)
	}
	for (const [path, value] of values) {
		const keys = path.split(".")
		const parent = keys.length === 1 ? body : valueAt(body, keys.slice(0, -1).join("."))
		if (!isFields(parent)) return cannot(`a sign-up body that holds the object ${path} sits in`)
		parent[keys.at(-1) as string] = value
	}
	return ready(body)
}

/* Each read whose answer declares every marked path, in the order they are tried. */
function readBacks(
	ctx: OperationContext,
	{ body, paths, raw }: { body: Fields; paths: readonly string[]; raw: OperationObject },
): ReadBack[] {
	const reads: ReadBack[] = []
	const self = selfReadOf(ctx.model, paths)
	if (self !== undefined) reads.push({ kind: "self", op: self })
	const listing = listingOf(ctx, { body, paths })
	if (listing !== undefined) reads.push(listing)
	if (declares(successSchema(raw), ctx.operation.recordPath, paths)) reads.push({ kind: "answer" })
	return reads
}

/* The caller's own read, a GET of the self-identity entity naming no record, whose answer declares every path. */
function selfReadOf(model: SpecModel, paths: readonly string[]): OperationModel | undefined {
	const reads = [...model.entities.values()]
		.filter((entity) => entity.identity === SELF_IDENTITY)
		/* An entity's reads name operations of the model. */
		.flatMap((entity) => selfReadIds(entity).map((id) => model.byOperationId.get(id) as OperationModel))
	return reads.find(
		(op) =>
			op.method.toUpperCase() === "GET" &&
			op.pathParams.length === 0 &&
			declares(successSchema(model.rawOperations.get(op.operationId) as OperationObject), op.recordPath, paths),
	)
}

/*
 * The listing of the entity the sign-up makes, when its rows declare every path and the body names
 * the account to find its row by; sent as the highest-ranked principal, its scope filling the path.
 */
function listingOf(
	ctx: OperationContext,
	{ body, paths }: { body: Fields; paths: readonly string[] },
): ReadBack | undefined {
	const list = ctx.model.entities.get(ctx.operation.entity ?? "")?.list
	/* An entity's list names an operation of the model. */
	const op = list === undefined ? undefined : (ctx.model.byOperationId.get(list) as OperationModel)
	const rows = op?.collection?.itemSchema ?? null
	if (op === undefined || !paths.every((path) => propertySchema(rows, path) !== undefined)) return undefined
	const identity = accountIdentity(body)
	if (Object.keys(identity).length === 0) return undefined
	const as = ctx.principals.toSorted((a, b) => b.rank - a.rank)[0] as Actor
	if (!op.pathParams.every((param) => Object.hasOwn(as.scope, param))) return undefined
	return { as, identity, kind: "listing", op, path: fillPath(op.path, as.scope) }
}

/* Where `x-entity.recordPath` keeps the record, as a dotted prefix: `$.data` is `data.`; a path through rows is none. */
const RECORD_PATH = /^\$((?:\.[^.[\]\s]+)*)$/

/* Whether the answer's schema declares every path in the record. */
function declares(schema: JsonSchema | null, recordPath: string | null, paths: readonly string[]): boolean {
	const match = RECORD_PATH.exec(recordPath ?? "$")
	if (match === null) return false
	const prefix = (match[1] as string).split(".").filter(Boolean)
	return paths.every((path) => propertySchema(schema, [...prefix, path].join(".")) !== undefined)
}

/**
 * Signs the account up, anonymously as any sign-up is sent, and judges by the first read that shows
 * it: a marked property holding the value it was set to is the finding. A sign-up refused made no
 * account with it, which passes; a server error leaves it unresolved.
 */
export async function signUpAndJudge(ctx: OperationWriteContext, probe: SignUpProbe): Promise<Outcome> {
	const { method, operationId, path, requiredQuery: query } = ctx.operation
	const names = probe.values.map(([field]) => field).join(", ")
	const signUp = await ctx.client.request(method, path, {
		as: { anonymous: true },
		body: probe.body,
		operationId,
		query,
	})
	if (signUp.status >= 500) {
		return ctx.findings.unresolved(
			CHECK,
			ctx.subject,
			`a sign-up that set ${names} drew ${signUp.status}, a server error`,
		)
	}
	if (signUp.status >= 300) return ASSERTED
	const reasons: string[] = []
	for (const read of probe.reads) {
		const shown = await readBack(ctx, { probe, read, signUp })
		if ("untested" in shown) reasons.push(shown.untested)
		else return judged(ctx, { probe, shown, signUp })
	}
	return standDown(`no read showed ${names} of the account ${operationId} made: ${reasons.join("; ")}`)
}

/** The account's record as one read shows it, and the exchanges it took. */
interface Shown {
	record: Fields
	from: string
	evidence: Exchange[]
}

async function readBack(
	ctx: OperationWriteContext,
	{ probe, read, signUp }: { probe: SignUpProbe; read: ReadBack; signUp: Exchange },
): Promise<Probed<Shown>> {
	const { operationId } = ctx.operation
	if (read.kind === "answer") {
		return showing(probe, {
			evidence: [],
			from: `${operationId}'s answer`,
			record: recordOf(ctx.operation, signUp.responseBody),
		})
	}
	const { op } = read
	const as = read.kind === "self" ? await ctx.accounts.signIn(signUp, op) : { principal: read.as.id }
	if ("untested" in as) return { untested: `${op.operationId}: ${as.untested}` }
	const path = read.kind === "self" ? op.path : read.path
	const exchange = await ctx.client.get(path, { as, operationId: op.operationId, query: op.requiredQuery })
	if (exchange.status >= 300) return { untested: `${op.operationId} answered ${exchange.status}` }
	if (read.kind === "self") {
		return showing(probe, {
			evidence: [exchange],
			from: `the account's own ${op.operationId}`,
			record: recordOf(op, exchange.responseBody),
		})
	}
	const row = recordsFromList(exchange.responseBody, op.collection).find((one) =>
		Object.entries(read.identity).every(([key, value]) => one[key] === value),
	)
	if (row === undefined) return { untested: `${op.operationId} as ${read.as.id} did not list the account` }
	return showing(probe, { evidence: [exchange], from: `${op.operationId} as ${read.as.id}`, record: row })
}

/* The read, when its record holds every marked path; else why it shows nothing. */
function showing(probe: SignUpProbe, shown: Omit<Shown, "record"> & { record: Fields | undefined }): Probed<Shown> {
	const { record } = shown
	const missing = probe.values.map(([path]) => path).filter((path) => valueAt(record, path) === undefined)
	if (record === undefined || missing.length > 0)
		return { untested: `${shown.from} did not show ${missing.join(", ")}` }
	return { ...shown, record }
}

function judged(
	ctx: OperationWriteContext,
	{ probe, shown, signUp }: { probe: SignUpProbe; shown: Shown; signUp: Exchange },
): Outcome {
	const { operationId } = ctx.operation
	const took = probe.values.filter(([path, value]) => isDeepStrictEqual(valueAt(shown.record, path), value))
	if (took.length === 0) return ASSERTED
	const set = took.map(([path, value]) => `${path} to ${JSON.stringify(value)}`).join(", ")
	return ctx.findings.security(CHECK, ctx.subject, {
		detail:
			`An anonymous sign-up by ${operationId} set ${set}, marked x-privileged; ${operationId} answered ` +
			`${signUp.status} and ${shown.from} shows the account holding it. Anyone who signs up gets a ` +
			"privilege only the highest rank may grant.",
		evidence: [signUp, ...shown.evidence],
		summary: `${operationId} grants ${took.map(([path]) => path).join(", ")}, marked x-privileged, to whoever signs up`,
	})
}

function isFields(value: unknown): value is Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function valueAt(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((at, key) => (isFields(at) ? at[key] : undefined), value)
}
