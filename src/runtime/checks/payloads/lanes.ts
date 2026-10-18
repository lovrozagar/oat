/**
 * How many lanes `payload.string-survives` runs. Through an update each lane writes a record of
 * its own, so there are never more lanes than records: shared, two lanes would read back each
 * other's writes. Through create every case is its own record.
 */
export function payloadLanes(input: { cases: number; max: number; records: number; viaPatch: boolean }): number {
	const bound = Math.min(input.max, input.cases)
	return Math.max(1, input.viaPatch ? Math.min(bound, input.records) : bound)
}
