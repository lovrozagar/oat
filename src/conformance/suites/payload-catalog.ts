import { catalogProblems, STRING_PAYLOADS } from "../../runtime/payloads.ts"
import type { ParserResult } from "../harness/result.ts"

export function runPayloadCatalogSuite(): ParserResult[] {
	const problems = catalogProblems()
	return [
		{
			detail: problems.join("; ") || `${STRING_PAYLOADS.length} cases, JSON-stable, no NUL`,
			name: "string-payload-catalog",
			ok: problems.length === 0,
			why: "the payload catalog must be unique, JSON-round-trippable, and cover every promised family",
		},
	]
}
