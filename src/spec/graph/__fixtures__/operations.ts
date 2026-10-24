import { doc } from "../../__fixtures__/documents.ts"
import { listEndpoints } from "../../endpoints.ts"
import { GapCollector } from "../../extensions/gaps.ts"
import { dereference } from "../../load/dereference.ts"
import { buildModel } from "../build.ts"
import { modelOperation } from "../operation.ts"
import type { OperationModel, SpecModel } from "../types.ts"

/* Operations and models read from real documents, so each pass is tested on what the passes before it produce. */

/** Every operation of a document, modeled one by one, before any whole-model pass. */
export function operationsOf(
	paths: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): { gaps: GapCollector; operations: OperationModel[] } {
	const document = dereference(doc(paths, extra)).doc
	const gaps = new GapCollector()
	return { gaps, operations: listEndpoints(document).map((endpoint) => modelOperation(endpoint, document, gaps)) }
}

/** The whole model of a document. */
export function modelOf(paths: Record<string, unknown>, extra: Record<string, unknown> = {}): SpecModel {
	return buildModel(dereference(doc(paths, extra)).doc)
}

/** One operation, modeled from `GET /things`, with the fields a test cares about laid over it. */
export function operation(overrides: Partial<OperationModel> = {}): OperationModel {
	const [base] = operationsOf({ "/things": { get: { operationId: "things.list", responses: {} } } }).operations
	return { ...(base as OperationModel), ...overrides }
}

/** Detail strings of the gaps recorded against one tag. */
export function details(gaps: GapCollector, tag: string): string[] {
	return gaps.gaps.filter((gap) => gap.tag === tag).map((gap) => gap.detail)
}
