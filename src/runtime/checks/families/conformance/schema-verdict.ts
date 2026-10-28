import type { SpecModel } from "../../../../spec/graph/types.ts"
import type { OperationObject } from "../../../../spec/types.ts"
import type { Exchange, SchemaVerdict } from "../../../exchange.ts"
import type { SchemaValidator, ValidationResult } from "../../../validate.ts"

/*
 * One judgment of a response body against the schema its operation documents for the status. A
 * body the transcript keeps whole is validated by the check that reads it; one kept only by
 * reference, past the in-memory limit, is validated when it is captured, by this same function, and
 * the check reads that verdict. Neither is judged twice.
 */

/** What the run's client is given: the verdict on an exchange's body, or `undefined` when nothing is documented. */
export function captureVerdict(
	validator: SchemaValidator,
	model: Pick<SpecModel, "rawOperations">,
): (exchange: Exchange) => SchemaVerdict | undefined {
	return (exchange) => {
		const { operationId } = exchange
		const raw = operationId === undefined ? undefined : model.rawOperations.get(operationId)
		if (operationId === undefined || raw === undefined || !validator.documents(raw, exchange.status)) return undefined
		const result = validator.validate(operationId, raw, exchange)
		return result.unchecked === undefined ? { errors: result.errors } : { errors: [], unchecked: result.unchecked }
	}
}

/** How a body holds to its documented schema: the verdict taken at capture when there is one, else validated now. */
export function verdictOf(
	validator: SchemaValidator,
	operation: { operationId: string; raw: OperationObject },
	exchange: Exchange,
): ValidationResult {
	const kept = exchange.schemaVerdict
	if (kept === undefined) return validator.validate(operation.operationId, operation.raw, exchange)
	if (kept.unchecked !== undefined) return { errors: [], ok: true, unchecked: kept.unchecked }
	return { errors: kept.errors, ok: kept.errors.length === 0 }
}
