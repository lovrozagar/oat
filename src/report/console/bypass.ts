/** The cache bypass each documented read is sent with, grouped for `doctor`. */

import type { SpecModel } from "../../spec/graph/types.ts"

export interface BypassGroup {
	/** `name: value` as sent; null when the config sends none. */
	bypass: string | null
	source: "declared" | "default" | "off"
	operations: string[]
}

/** Declared bypasses first, each once, then the default; one `off` group when `enabled` is false. */
export function bypassGroups(model: SpecModel, enabled: boolean): BypassGroup[] {
	const reads = model.operations.filter((op) => ["GET", "HEAD"].includes(op.method.toUpperCase()))
	if (reads.length === 0) return []
	if (!enabled) return [{ bypass: null, operations: reads.map((op) => op.operationId).sort(), source: "off" }]
	const groups = new Map<string, BypassGroup>()
	for (const op of reads) {
		const declared = op.consistency?.bypass
		const bypass =
			declared === undefined || declared === null ? "cache-control: no-cache" : `${declared.name}: ${declared.value}`
		const group = groups.get(bypass) ?? { bypass, operations: [], source: declared ? "declared" : "default" }
		group.operations.push(op.operationId)
		groups.set(bypass, group)
	}
	const sorted = [...groups.values()].map((group) => ({ ...group, operations: group.operations.sort() }))
	return [...sorted.filter((g) => g.source === "declared"), ...sorted.filter((g) => g.source === "default")]
}

/** One row per group: how many reads, naming them only where the document declared the bypass. */
export function bypassRows(groups: readonly BypassGroup[]): string[] {
	return groups.map((group) => {
		const label = group.source === "off" ? "off (config cache.bypass)" : `${group.source} ${group.bypass}`
		const count = `${group.operations.length} read${group.operations.length === 1 ? "" : "s"}`
		const named = group.source === "declared" ? `: ${group.operations.join(", ")}` : ""
		return `    ${label.padEnd(36)} ${count}${named}`
	})
}
