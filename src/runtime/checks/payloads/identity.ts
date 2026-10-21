import { absentIdentifier } from "../../generate/identifiers.ts"
import { type ClientIdentity, reserveIdentity } from "../../world/client-identity.ts"
import type { CheckContext } from "../core/context.ts"

/* ------------------------------------------------------------------- invented values */

/** This entity's identifier as its item route takes it: the path parameter's schema, else the record's. */
function identifierSchema(ctx: CheckContext): Record<string, unknown> {
	const properties = (ctx.listOp.collection?.itemSchema?.properties ?? {}) as Record<string, Record<string, unknown>>
	const recordIdentity = properties[ctx.identity]
	for (const op of [ctx.readOp, ctx.deleteOp, ctx.updateOp]) {
		if (op === undefined) continue
		const name = op.pathParams.at(-1)
		const raw = ctx.model.rawOperations.get(op.operationId)
		const declared = (raw?.parameters ?? []).find(
			(parameter) => "name" in parameter && parameter.in === "path" && parameter.name === name,
		) as { schema?: Record<string, unknown> } | undefined
		if (declared?.schema === undefined) continue
		/* A route parameter documented as a bare string says nothing; the record's own identity
		 * (an integer, a uuid) says what an identifier looks like. */
		if (bareString(declared.schema) && recordIdentity !== undefined && !bareString(recordIdentity)) {
			return recordIdentity
		}
		return declared.schema
	}
	return recordIdentity ?? { type: "string" }
}

/* A string schema with nothing that narrows it: no format, pattern, enum or length. */
function bareString(schema: Record<string, unknown>): boolean {
	return (
		schema.type === "string" &&
		["format", "pattern", "enum", "minLength", "maxLength", "const"].every((key) => schema[key] === undefined)
	)
}

/**
 * An identifier of the right shape that names nothing. A probe in the wrong format is answered
 * with a 400 before existence is ever considered, and comparing that with a real 404 reads as a
 * leak that is not there.
 */
export function absentId(ctx: CheckContext): string | null {
	return constructedAbsentId(ctx)
}

export const NO_ABSENT_ID = "an identifier of the documented shape that names no record"

/** A well-formed identifier that names nothing, or `null` when the identifier schema allows none. */
export function constructedAbsentId(ctx: CheckContext): string | null {
	const made = absentIdentifier(identifierSchema(ctx), ctx.nonce ?? "oat")
	return made.ok ? String(made.value) : null
}

/** The check's next salt; a context built outside a run counts the bodies its entity made instead. */
export function saltOf(ctx: CheckContext): string {
	if (ctx.nextSalt !== undefined) return ctx.nextSalt()
	const made = ((ctx.memo.entity.get("bodiesMade") as number | undefined) ?? 0) + 1
	ctx.memo.entity.set("bodiesMade", made)
	return `p${made}`
}

/**
 * The body with a client-chosen identity no record holds, reserved before the request goes out.
 * Anything that rewrites a body after `validBody` — making unique columns distinct — can move the
 * identity onto one a record already holds; this is the step to run again afterwards, or a create
 * meant to test something else collides on the identity instead.
 */
export function reserveClientIdentity(
	ctx: CheckContext,
	body: Record<string, unknown>,
	schema: Record<string, unknown>,
	salt: string,
): Record<string, unknown> {
	/* A client-chosen identity a record already holds would overwrite or collide with that record. */
	return reserveIdentity(body, clientIdentityOf(ctx, schema, `i${salt}`))
}

/**
 * How a check's create draws its client-chosen identity, and draws it again after a 409: from
 * outside the run's taken identities, when oat chooses one (`choosesIdentity`); else not at all.
 */
export function clientIdentityOf(ctx: CheckContext, schema: Record<string, unknown>, token: string): ClientIdentity {
	const taken = ctx.takenIdentities
	return {
		identity: taken !== undefined && choosesIdentity(ctx, schema) ? ctx.identity : null,
		schema,
		taken: taken ?? new Set(),
		token,
	}
}

/** Whether a create body carries an identity oat chooses and reserves. */
export function choosesIdentity(ctx: CheckContext, schema: Record<string, unknown>): boolean {
	return (
		ctx.takenIdentities !== undefined &&
		Object.hasOwn((schema.properties ?? {}) as Record<string, unknown>, ctx.identity)
	)
}
