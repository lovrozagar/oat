/**
 * `x-unique` is a declared fact. These cases prove a 409 duplicate is a pass, a 2xx is
 * BACKEND_BUG, and that missing / malformed tags do not invent a unique check.
 */

import { report } from "../report/console/report.ts"
import { buildModel } from "../spec/graph/build.ts"
import { listening, type Via } from "./harness/launch.ts"
import type { ParserResult } from "./harness/result.ts"
import { runCase, UNIQUE_CASES } from "./unique/cases.ts"
import { documentCases, untaggedDoctorCase } from "./unique/document.ts"
import { widgetSpec } from "./unique/spec.ts"

/** The document cases, every run through `via`, then the doctor of an untagged widget. */
export async function runUniqueSuite(via: Via = listening): Promise<ParserResult[]> {
	const results = documentCases()
	for (const unique of UNIQUE_CASES) results.push(...(await runCase(via, unique)))
	results.push(untaggedDoctorCase(report.doctor(buildModel(widgetSpec({ omitTag: true })), [], false).text))
	return results
}
