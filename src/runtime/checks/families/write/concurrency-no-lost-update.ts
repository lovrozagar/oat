import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import type { Record_ } from "../../../world/records.ts"
import type { CheckContext, WriteContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { readRecord, scratchRecord } from "../../isolation/scratch.ts"
import { requestSchemaOf, withheldProperties } from "../../payloads/body.ts"
import { standDownForFeatureGate, standDownForRateLimit } from "../../planning/stand-down.ts"
import { itemParamFor, subjectsOf } from "../../planning/subjects.ts"
import { NO_RECORD } from "./records.ts"
import type { JsonSchema } from "../../../../spec/types.ts"

/**
 * Concurrent writes to different fields must both survive.
 *
 * A handler that reads the row, then writes every column back — the `save(entity)` pattern —
 * reinstates whatever it read, so the later write silently reverts the earlier one. No error is
 * returned to either caller, which is what makes it so hard to notice from the outside.
 */
export const noLostUpdate = defineCheck<{ updateOp: OperationModel; readOp: OperationModel }>({
	plan: (ctx) => {
		const { readOp, updateOp } = ctx
		if (updateOp === undefined || readOp === undefined || ctx.createOp === undefined) return cannot()
		/* Two concurrent PUTs each replace the whole record, so one losing the other's field is
		 * what PUT means. Only partial writes can be lost. */
		if (updateOp.method.toUpperCase() !== "PATCH") return cannot("an update by PATCH, whose writes are partial")
		return ready({ readOp, updateOp })
	},
	dependsOn: [
		"list.read-after-write",
		"patch.minimality",
		/* If writes do not persist at all, "the write was lost" describes a consequence rather
		 * than a concurrency defect. */
		"create.persists-submitted-fields",
	],
	id: "concurrency.no-lost-update",
	needs: "a create, a PATCH update and two writable string fields",
	mutates: true,
	subjects: subjectsOf.update,
	async run(ctx, { readOp, updateOp }): Promise<Outcome> {
		const made = await scratchRecord(ctx, this.id)
		if ("outcome" in made) return made.outcome
		const params = { ...ctx.scope, ...itemParamFor(ctx, made.scratch.id) }
		const race: Race = { check: this.id, ctx, readPath: fillPath(readOp.path, params), readOp, updateOp }

		const original = await readBack(
			race,
			(status) => `reading the record back returned ${status}, so there was no baseline to race against`,
		)
		if ("outcome" in original) return original.outcome

		/* Two distinct writable string fields, so the writes cannot legitimately clobber each
		 * other — last-write-wins on the *same* field would be a defensible policy. */
		const fields = writableStringFields(ctx, original.record).slice(0, 2)
		const [first, second] = fields
		if (first === undefined || second === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`only ${fields.length} writable string field(s) are present on the record; two are ` +
					"needed so the concurrent writes cannot legitimately clobber each other",
			)
		}
		return raceAndJudge(race, fillPath(updateOp.path, params), [first, second])
	},
})

/** The record a race runs on, and how to reach it. */
interface Race {
	ctx: WriteContext
	check: string
	readOp: OperationModel
	updateOp: OperationModel
	readPath: string
}

/** The record as read now, with the response that carried it, or why it could not be read. */
async function readBack(
	race: Race,
	failed: (status: number) => string,
): Promise<{ record: Record_; exchange: Exchange } | { outcome: Outcome }> {
	const { check, ctx } = race
	const exchange = await ctx.client.get(race.readPath, { as: { principal: ctx.actor.id } })
	if (exchange.status >= 300)
		return { outcome: ctx.findings.unresolved(check, ctx.entityName, failed(exchange.status)) }
	const record = readRecord(race.readOp, exchange)
	if (record === undefined) return { outcome: ctx.findings.unresolved(check, ctx.entityName, NO_RECORD) }
	return { exchange, record }
}

/** Why the two concurrent writes cannot be judged — a feature gate, a rate limit, a refusal — or `undefined`. */
function raceRefusal(race: Race, firstWrite: Exchange, secondWrite: Exchange): Outcome | undefined {
	const { check, ctx, updateOp } = race
	if (standDownForFeatureGate(ctx, updateOp, firstWrite, check))
		return standDown("a documented feature gate refused the request")
	if (standDownForFeatureGate(ctx, updateOp, secondWrite, check))
		return standDown("a documented feature gate refused the request")
	if (standDownForRateLimit(ctx, firstWrite, check)) return standDown("the request was rate limited")
	if (standDownForRateLimit(ctx, secondWrite, check)) return standDown("the request was rate limited")
	if (firstWrite.status < 300 && secondWrite.status < 300) return undefined
	return ctx.findings.unresolved(
		check,
		ctx.entityName,
		`a concurrent PATCH was rejected (${firstWrite.status}, ${secondWrite.status}), so no ` +
			"race actually took place",
	)
}

async function raceAndJudge(race: Race, path: string, [first, second]: [string, string]): Promise<Outcome> {
	const { check, ctx } = race
	const [firstWrite, secondWrite] = await Promise.all([
		ctx.client.request("PATCH", path, {
			body: { [first]: "oat-concurrent-a" },
			as: { principal: ctx.actor.id },
		}),
		ctx.client.request("PATCH", path, {
			body: { [second]: "oat-concurrent-b" },
			as: { principal: ctx.actor.id },
		}),
	])
	const refused = raceRefusal(race, firstWrite, secondWrite)
	if (refused !== undefined) return refused

	const after = await readBack(race, (status) => `reading the record back after the race returned ${status}`)
	if ("outcome" in after) return after.outcome
	const current = after.record
	const lost: string[] = []
	if (current[first] !== "oat-concurrent-a") lost.push(first)
	if (current[second] !== "oat-concurrent-b") lost.push(second)
	if (lost.length === 0) {
		return ASSERTED
	}

	return ctx.findings.backend(check, ctx.entityName, {
		summary: "a concurrent write to a different field was silently lost",
		detail:
			`two simultaneous patches set "${first}" and "${second}" — different fields, so neither ` +
			`conflicts with the other — and both returned success, but ${lost.join(" and ")} ` +
			`read back as ${lost.map((f) => JSON.stringify(current[f])).join(", ")} afterwards. ` +
			"The update path reads the record and writes every column back, so whichever request " +
			"commits second reinstates the values it read before the first had committed. Callers " +
			"are told the write succeeded.",
		evidence: [firstWrite, secondWrite, after.exchange],
	})
}

/**
 * Fields a probe may write an arbitrary string into without the backend having grounds to refuse.
 *
 * "Writable" is not enough: an enum, a pattern or a length cap makes an arbitrary value invalid,
 * and a backend that rejects or normalises it is behaving correctly. Reading that back as a lost
 * write turns sound validation into a fabricated concurrency bug — which is exactly what happened
 * when a probe value was written into a `status` enum.
 */
function writableStringFields(ctx: CheckContext, record: Record_): string[] {
	/* The identity, what the update cannot change (immutable and generated fields), and what an
	 * ordinary body leaves out (`withheldProperties`). */
	const fixed = new Set([
		ctx.identity,
		...(ctx.updateOp?.immutable ?? []),
		...(ctx.updateOp?.generated ?? []),
		...withheldProperties(ctx, ctx.updateOp),
	])
	const schema = ctx.updateOp === undefined ? null : requestSchemaOf(ctx, ctx.updateOp)
	const properties = (schema?.properties ?? {}) as Record<string, JsonSchema>

	/* Where the update body enumerates its properties, that list *is* the set of writable fields —
	 * a field the request schema does not mention is one the caller was never invited to send, and
	 * a backend is right to ignore it. Reading the record instead of the schema is what let a probe
	 * target `status` on an operation that only accepts `name`. */
	const enumerated = Object.keys(properties).length > 0

	const out: string[] = []
	for (const [key, value] of Object.entries(record)) {
		if (!isFreeStringValue(key, value, fixed)) continue

		const propertySchema = properties[key]
		if (enumerated && propertySchema === undefined) continue
		if (propertySchema !== undefined && refusesArbitraryString(propertySchema)) continue
		out.push(key)
	}
	return out
}

/** A string the record holds under a key that is not the identity, immutable, generated, or a timestamp or reference. */
function isFreeStringValue(key: string, value: unknown, fixed: ReadonlySet<string>): boolean {
	if (fixed.has(key)) return false
	if (/_at$|_id$/.test(key)) return false
	return typeof value === "string"
}

/** Whether the schema has grounds to refuse an arbitrary short string: an enum, a pattern, a format, a tight cap. */
function refusesArbitraryString(propertySchema: JsonSchema): boolean {
	if (Array.isArray(propertySchema.enum)) return true
	if (typeof propertySchema.pattern === "string") return true
	if (typeof propertySchema.format === "string") return true
	/* The probe values are short, but a cap tight enough to reject them would make the
	 * write fail for a reason that has nothing to do with concurrency. */
	return typeof propertySchema.maxLength === "number" && propertySchema.maxLength < 32
}
