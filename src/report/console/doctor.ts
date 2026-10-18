/**
 * `doctor` is the adoption surface: it reports what oat cannot test against this spec and names
 * the meta tag that would close each gap. A backend team's path to full coverage is to run it
 * and work the list down.
 */

import type { SpecModel } from "../../spec/graph/types.ts"
import { type DoctorConfig, type DoctorFacts, doctorFacts } from "./doctor-facts.ts"
import { authLines, catalogLines, envelopeLines, externalRefLines, gapLines } from "./doctor-notes.ts"
import { declarationLines, entityLines, summaryLines, tagLines } from "./doctor-text.ts"

function doctorJson(model: SpecModel, facts: DoctorFacts, externalRefs: string[], config?: DoctorConfig): string {
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
			gaps: model.gaps.gaps,
			listableEntities: facts.listable.length,
			queryCatalog: facts.catalogs,
			...(config?.allowRemoved === undefined ? {} : { allowRemoved: config.allowRemoved }),
			roots: model.roots,
			testableEntities: facts.trackable.length,
			trackableEntities: facts.trackable.length,
			unknownEntities: facts.unknownEntities,
		},
		null,
		2,
	)}\n`
}

function doctorText(model: SpecModel, facts: DoctorFacts, externalRefs: string[], config?: DoctorConfig): string {
	const lines = [
		...summaryLines(facts, config),
		...tagLines(model, facts),
		...entityLines(model, facts),
		...declarationLines(facts),
		...catalogLines(facts),
		...envelopeLines(model),
		...authLines(model),
		...externalRefLines(externalRefs),
		...gapLines(facts),
	]
	if (facts.blocking === 0 && facts.gapsByTag.size === 0) lines.push("  no gaps — full coverage available\n")
	return lines.join("\n")
}

/** `oat doctor`: what oat can and cannot test in the document, as text or JSON, and how much of it blocks a run. */
export function doctor(
	model: SpecModel,
	externalRefs: string[],
	asJson: boolean,
	config?: DoctorConfig,
): { text: string; blocking: number } {
	const facts = doctorFacts(model, config)
	const text = asJson ? doctorJson(model, facts, externalRefs, config) : doctorText(model, facts, externalRefs, config)
	return { blocking: facts.blocking, text }
}
