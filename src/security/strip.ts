import { CREDENTIAL_HEADERS } from "./credential-names.ts"

/** The credential header names for a request: the known ones, plus those its principal injects. */
export function credentialHeaderNames(injected: Iterable<string> = []): Set<string> {
	return new Set([...CREDENTIAL_HEADERS, ...[...injected].map((name) => name.toLowerCase())])
}

/** Removes every credential header, in place, before a request follows a redirect to another origin. */
export function stripCredentials(headers: Record<string, string>, names: ReadonlySet<string>): void {
	for (const name of Object.keys(headers)) {
		if (names.has(name.toLowerCase())) delete headers[name]
	}
}

/** Removes every placed query parameter, in place, before a request follows a redirect to another origin. */
export function stripQuery(url: URL, names: ReadonlySet<string>): void {
	for (const name of names) url.searchParams.delete(name)
}
