import type { DocumentedStatuses } from "./types.ts"

export function readStatuses(responses: Record<string, unknown> | undefined): DocumentedStatuses {
	const exact: number[] = []
	const ranges: number[] = []
	let hasDefault = false
	for (const key of Object.keys(responses ?? {})) {
		if (/^[1-5]\d\d$/.test(key)) exact.push(Number(key))
		else if (/^[1-5]xx$/i.test(key)) ranges.push(Number(key[0]))
		else if (key === "default") hasDefault = true
	}
	return { default: hasDefault, exact: exact.sort((a, b) => a - b), ranges: ranges.sort((a, b) => a - b) }
}

/** Whether `status` is covered: named exactly, by its range, or by `default`. */
export function documentsStatus(statuses: DocumentedStatuses, status: number): boolean {
	return statuses.exact.includes(status) || statuses.ranges.includes(Math.floor(status / 100)) || statuses.default
}

/** The success statuses as the document spells them, for messages. */
export function describeSuccess(statuses: DocumentedStatuses): string[] {
	return [
		...statuses.exact.filter((code) => code < 300).map(String),
		...statuses.ranges.filter((c) => c === 2).map(() => "2XX"),
	]
}
