import type { Exchange } from "./exchange.ts"

/** The request a seed failed on, when the failure was an HTTP response. */
export interface FailedRequest {
	/** Status the failing request returned. */
	status: number
	/** The create that failed — a parent's, not always the entity's own. */
	operationId?: string
	exchange?: Exchange
}

/** Why a record oat needed could not be made or found: the parameter or operation, and the answer. */
export class SeedError extends Error {
	/** Status the failing request returned, when the failure was an HTTP response. */
	readonly status: number | undefined
	/** The create that failed, when the failure was one — a parent's, not always the entity's own. */
	readonly operationId: string | undefined
	readonly exchange: Exchange | undefined

	constructor(
		/** The path parameter or operation the seed failed on. */
		readonly culprit: string,
		message: string,
		request?: FailedRequest,
	) {
		super(message)
		this.status = request?.status
		this.operationId = request?.operationId
		this.exchange = request?.exchange
	}
}
