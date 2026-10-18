import type { OperationModel } from "../../../../spec/graph.ts"

/**
 * Isolation checks need a tenant boundary to have meaning. A public catalogue has neither
 * `x-tenant` nor a path parameter that looks like one; a 200 from another principal is the
 * contract, not a leak.
 */
export function tenantBoundary(op: OperationModel | undefined): boolean {
	if (op === undefined) return false
	return !(op.tenantSource === null && (op.tenantParam === null || op.tenantParam === undefined))
}
