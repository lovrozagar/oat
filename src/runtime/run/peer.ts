/**
 * The principal the isolation checks cross into from the first: the first other that holds a tenant
 * of its own, one the first does not hold. A principal with no tenant (a platform admin, say) is in
 * no tenant, so it is never the other side of a boundary, wherever the config lists it.
 */
export function peerOf<T extends { tenant?: string | undefined }>(candidates: readonly [T, ...T[]]): T | undefined {
	const [first] = candidates
	return candidates.find((other) => other.tenant !== undefined && other.tenant !== first.tenant)
}
