/*
 * What a config asks of a document beyond its recipes: that it no longer leans on the removed
 * `x-auth-flows` tag, that every scenario step naming a `scheme` names one the document the step
 * goes to declares (the step's origin's, else the scenario's, else the primary), and that
 * `targetVersion.scheme` names one the primary document declares.
 */

import { nearest } from "../../errors/suggest.ts"
import { declaredSchemes } from "./principals.ts"

type Raw = Record<string, unknown>

/** The parts of a document's view these checks read. */
export interface DocumentView {
	authFlows: boolean
	schemes: ReadonlyMap<string, unknown>
}

const isRecord = (value: unknown): value is Raw => value !== null && typeof value === "object" && !Array.isArray(value)

/** Problems a config has with the primary document and each origin's that no recipe check sees. */
export function documentProblems(
	config: Raw,
	spec: DocumentView,
	origins: Readonly<Record<string, DocumentView>> = {},
): string[] {
	const tagged = spec.authFlows
		? ["the document's x-auth-flows tag is no longer read: declare a security.<scheme> recipe in config"]
		: []
	const scenarios = Array.isArray(config.scenarios) ? config.scenarios.filter(isRecord) : []
	return [
		...tagged,
		...scenarios.flatMap((scenario) => stepSchemeProblems(scenario, { origins, spec })),
		...targetVersionProblems(config, spec),
	]
}

/* The scheme an undocumented version path is read under, against the primary document. */
function targetVersionProblems(config: Raw, spec: DocumentView): string[] {
	const scheme = isRecord(config.targetVersion) ? config.targetVersion.scheme : undefined
	if (typeof scheme !== "string" || spec.schemes.has(scheme)) return []
	return [unknownScheme({ path: "targetVersion.scheme", scheme, view: spec, where: "the document" })]
}

/** A config key naming a scheme, and the document it was looked for in. */
interface SchemeReference {
	path: string
	scheme: string
	view: DocumentView
	where: string
}

/* `<path> "<scheme>" names no scheme in <where>`, with the closest declared one and the full list. */
function unknownScheme({ path, scheme, view, where }: SchemeReference): string {
	const close = nearest(scheme, view.schemes.keys())[0]
	return (
		`${path} "${scheme}" names no scheme in ${where}.` +
		`${close === undefined ? "" : ` Did you mean "${close}"?`} ${declaredSchemes(view.schemes.keys())}`
	)
}

/* Each step's `scheme`, against the document the step goes to. An unknown origin is reported elsewhere. */
function stepSchemeProblems(
	scenario: Raw,
	documents: { spec: DocumentView; origins: Readonly<Record<string, DocumentView>> },
): string[] {
	const steps = Array.isArray(scenario.steps) ? scenario.steps : []
	return steps.flatMap((step: unknown, index) => {
		if (!isRecord(step) || typeof step.scheme !== "string") return []
		const origin = typeof step.origin === "string" ? step.origin : scenario.origin
		const view = typeof origin === "string" ? documents.origins[origin] : documents.spec
		if (view === undefined || view.schemes.has(step.scheme)) return []
		const where = typeof origin === "string" ? `origin ${origin}'s document` : "the document"
		const path = `scenarios.${String(scenario.id)}.steps[${index}].scheme`
		return [unknownScheme({ path, scheme: step.scheme, view, where })]
	})
}
