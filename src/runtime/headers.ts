/** Header lookup, once: HTTP header names are case-insensitive, and every reader must agree. */

/** The value of header `name`, matched case-insensitively. */
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const want = name.toLowerCase()
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === want) return value
	}
	return undefined
}

/** The value of header `name`, unless it is blank — a header sent empty says nothing. */
export function presentHeader(headers: Record<string, string>, name: string): string | undefined {
	const value = headerValue(headers, name)
	return value === undefined || value.trim() === "" ? undefined : value
}
