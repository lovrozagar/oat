import type { OperationCheck } from "../../core/check.ts"
import type { Actor } from "../../core/context.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationContext, OperationWriteContext, WriteTarget } from "../../core/operation-context.ts"
import { isUntested, targetPlan } from "../../core/operation.ts"
import { andThen, cannot, type Plan, ready } from "../../core/plan.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { noSecurityReason } from "../../../no-security.ts"
import { requestContent } from "../../../../spec/collection/request.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { OperationObject } from "../../../../spec/types.ts"
import { type SchemeOutcome, unlessUnsatisfied } from "./lifecycle.ts"
import { isSignUp, signUpAndJudge, type SignUpProbe, signUpPlan } from "./privileged-signup.ts"
import { currentOf, readOf, recordAt, writableBody } from "./writable.ts"

type Fields = Record<string, unknown>

/** The record written to, how it is re-read, who writes, who outranks it, and the body it sends. */
interface RecordProbe {
	kind: "record"
	target: WriteTarget
	read: OperationModel
	/** What any writer may send of the record as it is now; the marked properties are set on it. */
	body: Fields
	/** Every rank below the top of the owner's tenant, highest first: the next writes when one cannot. */
	writers: Actor[]
	top: Actor
	changes: ReadonlyArray<[path: string, value: unknown]>
}

/** A write to a record the run created, or a sign-up of an account of its own. */
type PrivilegedProbe = RecordProbe | SignUpProbe

/**
 * Only the highest rank may set a property the document marks `x-privileged: true`. A principal
 * ranked below it writes a record this run created, through a dedicated credential (never its own
 * session): the record's current state cut to what the request body accepts, each marked property
 * changed. The verdict is the record as its owner re-reads it, not the status: a marked property
 * left as it was passes, whether the write drew a 403, a 400 naming it, or a 200; one that changed is
 * the finding. A refusal passes only once the same writer's harmless write is accepted: a writer whose
 * role cannot update the record proves nothing, and the next rank below the top writes instead. A
 * server error, a record that cannot be re-read, or no rank able to write leaves it unresolved. A sign-up,
 * which anyone may send, must not grant one either: see `privileged-signup.ts`.
 */
export const privilegedFieldIgnored: OperationCheck<PrivilegedProbe> = defineCheck<PrivilegedProbe>({
	id: "auth.privileged-field-ignored",
	mutates: true,
	needs:
		"a property marked x-privileged, and a sign-up or a run-created record with a principal ranked below the highest",
	plan: (ctx) => {
		if (ctx.operation.privileged.length > 0 && isSignUp(ctx)) return signUpPlan(ctx)
		const undeclared = noSecurityReason(ctx.operation)
		if (undeclared !== undefined) return cannot(undeclared)
		if (ctx.operation.privileged.length === 0) {
			const marked = ctx.model.operations.some((op) => op.privileged.length > 0)
			return cannot(
				marked
					? `a request body property marked x-privileged; ${ctx.operation.operationId} marks none`
					: "no property is marked x-privileged",
			)
		}
		return andThen(targetPlan(ctx), (target) => {
			const read = readOf(ctx)
			if (read === undefined) return cannot("a GET on the write's path, to re-read the record")
			const record = currentOf(target)
			if (record === undefined) return cannot("the target record's current state, for a harmless body")
			const body = writableBody(ctx, record)
			return andThen(changesOf(ctx, { body, record }), (changes) =>
				andThen(writersOf(ctx, target), (pair) => ready({ ...pair, body, changes, kind: "record", read, target })),
			)
		})
	},
	subject: "operation",
	async run(ctx, probe) {
		if (probe.kind === "signup") return signUpAndJudge(ctx, probe)
		const reasons: string[] = []
		for (const set of ctx.operation.security.alternatives) {
			const scheme = set.length === 1 ? set[0] : undefined
			if (scheme === undefined) continue
			const outcome = await acrossWriters(ctx, { probe, scheme })
			if (!("untested" in outcome)) return outcome
			reasons.push(outcome.untested)
		}
		return standDown(reasons.join("; "))
	},
})

const CHECK = "auth.privileged-field-ignored"

/** One scheme of the write, as its single member. */
type Scheme = OperationModel["security"]["alternatives"][number][number]

/**
 * Each writer in turn, until one can update the record at all. A writer refused even the harmless
 * write proves nothing about the marked properties (its role may not update this record), so the next
 * rank below the top writes. Unresolved when every such rank was refused; untested when none could be
 * sent as.
 */
async function acrossWriters(
	ctx: OperationWriteContext,
	{ probe, scheme }: { probe: RecordProbe; scheme: Scheme },
): Promise<SchemeOutcome> {
	const refused: string[] = []
	const untested: string[] = []
	for (const writer of probe.writers) {
		/* The write spends nothing of the credential, so one of the writer's serves every such probe. */
		const dedicated = await ctx.probe.dedicated({
			principal: writer.id,
			reusable: true,
			scheme: scheme.scheme,
			scopes: scheme.scopes,
		})
		if (isUntested(dedicated)) {
			untested.push(`${scheme.scheme}: ${dedicated.untested}`)
			continue
		}
		const as = { principal: dedicated.actor.principal, scheme: scheme.scheme }
		const outcome = await unlessUnsatisfied(scheme.scheme, () => writeAndJudge(ctx, { as, probe, writer }))
		if ("untested" in outcome) untested.push(outcome.untested)
		else if ("refused" in outcome) refused.push(outcome.refused)
		else return outcome
	}
	/* One reason per scheme, however many writers it stopped. */
	if (refused.length === 0) return { untested: [...new Set(untested)].join("; ") }
	const names = probe.changes.map(([path]) => path).join(", ")
	const reason = `no rank below ${probe.top.id} can update the record (${refused.join(", ")}), so whether one may set ${names} is untested`
	return ctx.findings.unresolved(CHECK, ctx.subject, reason)
}

async function writeAndJudge(
	ctx: OperationWriteContext,
	{ as, probe, writer }: { as: { principal: string; scheme: string }; probe: RecordProbe; writer: Actor },
): Promise<Outcome | { refused: string }> {
	const { changes, read, target, top } = probe
	const { method, operationId, requiredQuery: query } = ctx.operation
	const names = changes.map(([path]) => path).join(", ")
	const body = structuredClone(probe.body)
	for (const [path, value] of changes) setAt(body, path, value)
	const wrote = await ctx.client.request(method, target.path, { as, body, operationId, probe: true, query })
	if (wrote.status >= 500) {
		return ctx.findings.unresolved(
			CHECK,
			ctx.subject,
			`${writer.id}'s write of ${names} drew ${wrote.status}, a server error`,
		)
	}
	const reread = await ctx.client.get(target.path, {
		as: { principal: target.owner },
		operationId: read.operationId,
		query: read.requiredQuery,
	})
	const state = reread.status < 300 ? recordAt(ctx, reread.responseBody) : undefined
	if (state === undefined) {
		const reason = `the record could not be re-read after the write (${reread.status}), so whether ${names} changed is unknown`
		return ctx.findings.unresolved(CHECK, ctx.subject, reason)
	}
	const applied = changes.filter(([path, value]) => Object.is(valueAt(state, path), value)).map(([path]) => path)
	if (applied.length === 0) return wrote.status < 400 ? ASSERTED : controlled(ctx, { as, probe, writer })
	return ctx.findings.security(CHECK, ctx.subject, {
		detail:
			`${writer.id} (rank ${writer.rank}) wrote ${applied.join(", ")}, marked x-privileged, on a record ` +
			`this run created; ${operationId} answered ${wrote.status} and the re-read shows it applied. Only ` +
			`${top.id} (rank ${top.rank}), the highest rank, may set it.`,
		evidence: [wrote, reread],
		summary: "a write below the highest rank sets an x-privileged property",
	})
}

/*
 * A refused probe, told apart: the same writer sends the harmless body alone. Accepted, the refusal
 * was the marked properties' (a pass); refused too, this writer cannot update the record at all.
 */
async function controlled(
	ctx: OperationWriteContext,
	{ as, probe, writer }: { as: { principal: string; scheme: string }; probe: RecordProbe; writer: Actor },
): Promise<Outcome | { refused: string }> {
	const { method, operationId, requiredQuery: query } = ctx.operation
	const control = await ctx.client.request(method, probe.target.path, {
		as,
		body: structuredClone(probe.body),
		operationId,
		probe: true,
		query,
	})
	return control.status < 300 ? ASSERTED : { refused: `${writer.id} ${control.status}` }
}

/* The writers: every principal of the target owner's tenant ranked below its highest, highest first. */
function writersOf(ctx: OperationContext, target: WriteTarget): Plan<{ writers: Actor[]; top: Actor }> {
	const owner = ctx.principals.find((actor) => actor.id === target.owner) ?? ctx.actor
	const home = ctx.principals.filter((actor) => actor.tenant === owner.tenant).toSorted((a, b) => b.rank - a.rank)
	const top = home[0] as Actor
	const writers = home.filter((actor) => actor.rank < top.rank)
	return writers.length === 0
		? cannot("a principal ranked below the highest of the target owner's tenant")
		: ready({ top, writers })
}

/*
 * Each marked property with the value the probe sets it to, changed from the record's own; any one oat
 * cannot change, or whose parent the body (which never carries a marked property) lacks, stands it down.
 */
function changesOf(
	ctx: OperationContext,
	{ body, record }: { body: Fields; record: Fields },
): Plan<Array<[string, unknown]>> {
	const changes: Array<[string, unknown]> = []
	for (const path of ctx.operation.privileged) {
		const value = changed(valueAt(record, path), typeOf(ctx, path))
		if (value === undefined || !isFields(parentOf(body, path))) return cannot(`a value of ${path} oat can change`)
		changes.push([path, value])
	}
	return ready(changes)
}

/* A different value of the same type: a boolean flipped (a missing boolean set), a number one up, a string suffixed. */
function changed(current: unknown, type: unknown): unknown {
	if (typeof current === "boolean") return !current
	if (typeof current === "number") return current + 1
	if (typeof current === "string") return `${current}-oat`
	return current === undefined && type === "boolean" ? true : undefined
}

/* The declared type of the request body property at the dotted `path`. */
function typeOf(ctx: OperationContext, path: string): unknown {
	/* The model holds every operation it lists; a marked property implies a request body. */
	const raw = ctx.model.rawOperations.get(ctx.operation.operationId) as OperationObject
	return valueAt(requestContent(raw), `schema.properties.${path.split(".").join(".properties.")}.type`)
}

function isFields(value: unknown): value is Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function valueAt(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((at, key) => (isFields(at) ? at[key] : undefined), value)
}

/* The object holding the last segment of `path`. */
function parentOf(value: unknown, path: string): unknown {
	const keys = path.split(".")
	return keys.length === 1 ? value : valueAt(value, keys.slice(0, -1).join("."))
}

function setAt(value: Fields, path: string, next: unknown): void {
	const keys = path.split(".")
	const last = keys.at(-1) as string
	;(parentOf(value, path) as Fields)[last] = next
}
