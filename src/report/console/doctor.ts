/**
 * `doctor` is the adoption surface: it reports what oat cannot test against this spec and names
 * the meta tag that would close each gap. A backend team's path to full coverage is to run it
 * and work the list down.
 */

import type { SpecModel } from "../../spec/graph/types.ts"
import { type DoctorConfig, type DoctorFacts, doctorFacts } from "./doctor-facts.ts"
import { authLines, catalogLines, envelopeLines } from "./doctor-notes.ts"
import { declarationLines, entityLines, summaryLines, tagLines } from "./doctor-text.ts"
import { externalRefLines, gapLines } from "./gaps.ts"
import { securityJson } from "./security.ts"
import { securityLines } from "./security-text.ts"

/** How `doctor` reports: the external refs the document named, JSON or text, and the config beside it. */
export interface DoctorOptions {
	/** Refs to other files, which oat did not follow. */
	externalRefs?: string[]
	asJson?: boolean
	config?: DoctorConfig | undefined
	/** Variables the config names that are not set: a note, never a block. Given only with a config. */
	unsetEnv?: string[] | undefined
}

/* Everything one doctor report is written from. */
interface Diagnosis {
	model: SpecModel
	facts: DoctorFacts
	externalRefs: string[]
	config: DoctorConfig | undefined
	unsetEnv: string[] | undefined
}

/** The note for variables a config names that are not set, or nothing when every one is. */
export function unsetEnvLines(unsetEnv: readonly string[] | undefined): string[] {
	if (unsetEnv === undefined || unsetEnv.length === 0) return []
	return [`  ${"env".padEnd(11)}${unsetEnv.join(", ")} not set — a run stops until they are`, ""]
}

function doctorJson({ config, externalRefs, facts, model, unsetEnv }: Diagnosis): string {
	return `${JSON.stringify(
		{
			blocking: facts.blocking,
			entities: facts.entities.length,
			externalRefs,
			featureGates: facts.featureGates,
			invites: facts.inviting.map((entity) => ({
				accept: entity.invite.accept,
				acceptFrom: entity.invite.acceptFrom === "link" ? "link" : "token",
				entity: entity.name,
				tokenFrom: entity.invite.tokenFrom,
			})),
			uniqueConstraints: facts.uniqueConstraints,
			gaps: facts.gaps,
			listableEntities: facts.listable.length,
			queryCatalog: facts.catalogs,
			...(config?.allowRemoved === undefined ? {} : { allowRemoved: config.allowRemoved }),
			roots: model.roots,
			security: securityJson(facts.security),
			testableEntities: facts.trackable.length,
			trackableEntities: facts.trackable.length,
			unknownEntities: facts.unknownEntities,
			...(unsetEnv === undefined ? {} : { unsetEnv }),
		},
		null,
		2,
	)}\n`
}

/* Said only where the document declares or names a scheme: `authLines` already speaks for one that declares none. */
function securityBlock(facts: DoctorFacts): string[] {
	const { security } = facts
	return security.schemes.length === 0 && security.undeclared.length === 0 ? [] : securityLines(security)
}

function doctorText({ config, externalRefs, facts, model, unsetEnv }: Diagnosis): string {
	const lines = [
		...summaryLines(facts, config),
		...tagLines(model, facts),
		...entityLines(model, facts),
		...declarationLines(facts),
		...catalogLines(facts),
		...envelopeLines(model),
		...authLines(model),
		...securityBlock(facts),
		...unsetEnvLines(unsetEnv),
		...externalRefLines(externalRefs),
		...gapLines(facts),
	]
	if (facts.blocking === 0 && facts.gapsByTag.size === 0) lines.push("  no gaps — full coverage available\n")
	return lines.join("\n")
}

/** `oat doctor`: what oat can and cannot test in the document, as text or JSON, and how much of it blocks a run. */
export function doctor(model: SpecModel, options: DoctorOptions = {}): { text: string; blocking: number } {
	const { asJson = false, config, externalRefs = [], unsetEnv } = options
	const facts = doctorFacts(model, config)
	const diagnosis = { config, externalRefs, facts, model, unsetEnv }
	return { blocking: facts.blocking, text: asJson ? doctorJson(diagnosis) : doctorText(diagnosis) }
}
