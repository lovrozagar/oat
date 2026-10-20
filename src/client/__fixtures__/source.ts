/** A credential source that always answers the same, and records what it was asked. */

import type { CredentialRequest, CredentialSource, Resolution } from "../credential-source.ts"

export function fixedSource(resolution: Resolution): CredentialSource & { asked: CredentialRequest[] } {
	const asked: CredentialRequest[] = []
	return {
		asked,
		resolve: async (request) => {
			asked.push(request)
			return resolution
		},
	}
}

/** `principal` sending `headers` under one scheme, renewed by `refresh`. */
export function sendingHeaders(
	headers: Record<string, string>,
	more: { principal?: string; refresh?: () => Promise<Resolution> } = {},
): Resolution {
	return {
		block: () => undefined,
		kind: "sends",
		principal: more.principal ?? "alpha",
		refresh: more.refresh ?? (async () => ({ kind: "anonymous" })),
		schemes: ["jwt"],
		secrets: { cookies: [], headers: Object.keys(headers), query: [], values: Object.values(headers) },
		sends: { jwt: { cookies: {}, headers, query: {} } },
		sentValues: { jwt: Object.values(headers).join(" ") },
	}
}
