export function primaryOf(expected: string | string[]): string {
	return Array.isArray(expected) ? (expected[0] ?? "") : expected
}

export function acceptableOf(expected: string | string[]): string[] {
	return Array.isArray(expected) ? expected : [expected]
}
