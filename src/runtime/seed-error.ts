import type { Exchange } from "./exchange.ts"

/** Why a record oat needed could not be made or found: the parameter or operation, and the answer. */
export class SeedError extends Error {
	constructor(
		/** The path parameter or operation the seed failed on. */
		readonly culprit: string,
		message: string,
		/** Status the failing request returned, when the failure was an HTTP response. */
		readonly status?: number,
		/** The create that failed, when the failure was one — a parent's, not always the entity's own. */
		readonly operationId?: string,
		readonly exchange?: Exchange,
	) {
		super(message)
	}
}
