function planLimitSignal(body: unknown): string | null {
	if (body === null || typeof body !== "object") return null
	const rec = body as Record<string, unknown>
	const candidates: unknown[] = [
		rec["error"],
		rec["error_key"],
		rec["code"],
		rec["type"],
		rec["reason"],
		rec["status_key"],
	]
	const vars = rec["vars"]
	if (vars !== null && typeof vars === "object") {
		const inner = vars as Record<string, unknown>
		candidates.push(inner["type"], inner["code"], inner["error"], inner["error_key"])
	}
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue
		const normalised = candidate.toLowerCase()
		if (normalised === "payment_required" || normalised === "plan_limit" || normalised.includes("plan_limit")) {
			return normalised
		}
	}
	return null
}

/**
 * A plan-limit refusal — 402, or a 4xx whose body names payment_required / *_plan_limit.
 *
 * Not a fixture defect: the tenant already has the thing (extract created a table, the free
 * plan is full). Callers reuse an existing same-tenant row instead of inventing one.
 */
export function isPlanLimitResponse(status: number, body: unknown): boolean {
	if (status === 402) return true
	if (status < 400 || status >= 500 || status === 429) return false
	return planLimitSignal(body) !== null
}
