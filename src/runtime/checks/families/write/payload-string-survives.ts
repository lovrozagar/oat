import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph.ts"
import type { Exchange } from "../../../exchange.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { STRING_PAYLOADS } from "../../../payloads.ts"
import type { Record_ } from "../../../world.ts"
import { cannot, ready } from "../../core/plan.ts"
import { scratchRecord } from "../../isolation/scratch.ts"
import { standDownForFeatureGate, standDownForRateLimit } from "../../planning/stand-down.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { ASCII_PAYLOAD_PROBE, payloadCases, type PayloadField, pickPayloadField } from "./payload-cases.ts"
import {
	type CaseResult,
	identityOf,
	laneRecords,
	type PayloadProbe,
	readField,
	removeRecord,
	runLanes,
	viaPatch,
	writeField,
} from "./payload-probe.ts"

export const stringPayloadSurvives = defineCheck<{
	writeOp: OperationModel
	readOp: OperationModel
	field: PayloadField
}>({
	plan: (ctx) => {
		const writeOp = ctx.updateOp ?? ctx.createOp
		const readOp = ctx.readOp
		if (writeOp === undefined || readOp === undefined || ctx.createOp === undefined) return cannot()
		if (ctx.updateOp === undefined && ctx.deleteOp === undefined) return cannot()
		const field = pickPayloadField(ctx, writeOp)
		if (field === null) return cannot("a writable string field without a format or pattern to probe payloads against")
		return ready({ field, readOp, writeOp })
	},
	dependsOn: ["list.read-after-write"],
	id: "payload.string-survives",
	mutates: true,
	needs: "an update or create+delete, an item route, and a writable unconstrained string",
	subjects: subjectsOf.writeAndRead,
	async run(ctx, { field, readOp, writeOp }): Promise<Outcome> {
		let id = ""
		let current: Record_ = {}
		if (ctx.updateOp !== undefined) {
			const made = await scratchRecord(ctx, this.id)
			if ("outcome" in made) return made.outcome
			id = made.scratch.id
			current = made.scratch.record
		}
		const probe: PayloadProbe = { check: this.id, ctx, currents: new Map([[id, current]]), field, id, readOp, writeOp }
		const control = await controlFailure(probe)
		if (control !== undefined) return control
		const { cases, narrowed } = payloadCases(ctx, writeOp, field)
		const results = await runLanes(probe, cases, await laneRecords(probe, cases.length))
		const stop = results.find((result) => result?.kind === "stop")
		if (stop?.kind === "stop") return stop.outcome
		if (narrowed !== null) {
			ctx.findings.gap(
				this.id,
				ctx.entityName,
				`${cases.length} of ${STRING_PAYLOADS.length} payload cases sent to "${field.name}"`,
				`the whole catalog already ran against this write path on ${narrowed}, so this field got one ` +
					'case of each family. Set `payloads: "full"` to send every case to every field.',
			)
		}
		return verdict(probe, results)
	},
})

/** Why the ASCII control write does not let the payload cases be judged, or `undefined` when it does. */
async function controlRefusal(probe: PayloadProbe, control: Exchange): Promise<Outcome | undefined> {
	const { check, ctx, field, writeOp } = probe
	if (standDownForFeatureGate(ctx, writeOp, control, check))
		return standDown("a documented feature gate refused the request")
	if (standDownForRateLimit(ctx, control, check)) return standDown("the request was rate limited")
	if (control.status === 401 || control.status === 403) {
		return ctx.findings.unresolved(
			check,
			ctx.entityName,
			`the ASCII control write returned ${control.status}, so later refusals cannot be attributed to the payload`,
		)
	}
	if (control.status >= 400 && control.status < 500) {
		return ctx.findings.unresolved(
			check,
			ctx.entityName,
			`the ASCII control write was rejected with ${control.status}, so the field refuses ordinary strings`,
		)
	}
	if (control.status < 500) return undefined
	return ctx.findings.backend(
		check,
		ctx.entityName,
		"an ordinary ASCII write returned 5xx",
		`PATCH/POST of "${ASCII_PAYLOAD_PROBE}" on "${field.name}" returned ${control.status}.`,
		[control],
	)
}

/** Writes and reads back an ordinary ASCII string first: a field that loses it is not judged on payloads. */
async function controlFailure(probe: PayloadProbe): Promise<Outcome | undefined> {
	const { check, ctx, field } = probe
	const control = await writeField(probe, ASCII_PAYLOAD_PROBE, probe.id)
	const refused = await controlRefusal(probe, control)
	if (refused !== undefined) return refused
	const controlId = viaPatch(probe) ? probe.id : await identityOf(probe, control)
	if (controlId === undefined) {
		return ctx.findings.unresolved(
			check,
			ctx.entityName,
			"the ASCII control write did not return an identity, so the value could not be read back",
		)
	}
	const controlRead = await readField(probe, controlId)
	if (!viaPatch(probe)) await removeRecord(probe, controlId)
	if (controlRead.value === ASCII_PAYLOAD_PROBE) return undefined
	return ctx.findings.backend(
		check,
		ctx.entityName,
		"an ordinary ASCII write did not persist exactly",
		`"${field.name}" was sent ${JSON.stringify(ASCII_PAYLOAD_PROBE)} and read back ` +
			`${JSON.stringify(controlRead.value)}.`,
		[control, controlRead.exchange],
	)
}

function verdict(probe: PayloadProbe, results: ReadonlyArray<CaseResult | undefined>): Outcome {
	const { check, ctx, field } = probe
	const failed: string[] = []
	const evidence: Exchange[] = []
	for (const result of results) {
		if (result?.kind !== "failed") continue
		failed.push(result.line)
		if (evidence.length < 4) evidence.push(...result.evidence)
	}
	const lostAuth = results.some((result) => result?.kind === "lost-auth")
	if (lostAuth && failed.length === 0) {
		return ctx.findings.unresolved(
			check,
			ctx.entityName,
			"authentication failed in the middle of the payload catalog, so remaining cases were not run",
		)
	}
	if (failed.length === 0) return ASSERTED
	return ctx.findings.backend(
		check,
		ctx.entityName,
		"a documented-valid string did not survive a write",
		`"${field.name}" failed ${failed.length} payload case(s): ${failed.slice(0, 6).join("; ")}` +
			(failed.length > 6 ? `; and ${failed.length - 6} more` : "") +
			". The document accepts these as strings; refusing or mutating them is silent corruption " +
			"or an undocumented constraint.",
		evidence,
	)
}
