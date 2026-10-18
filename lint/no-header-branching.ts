import type { Context, Literal, Node, Rule } from "./ast.ts"
import { isTestCode, repoPath } from "./paths.ts"

/*
 * Where a credential goes is the operation's OpenAPI `security` to say: a bearer token, a basic
 * pair, an API key in a header, query or cookie. Code that writes an auth header's name or a
 * scheme's prefix itself sends one header everywhere, which is the bug 0.25.0 removes. Only the
 * security, credential and placement modules, the reference server, the self-test (which plays
 * both a backend and a user configuring principals) and tests name them.
 */
const HOMES = [
	"/src/security/",
	"/src/spec/security/",
	"/src/credentials/",
	"/src/client/credentials.ts",
	"/src/reference/",
	"/src/conformance/", // until 8.10: the self-test principals carry headers until its configs move to security recipes
]
const HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key"])
/* A credential template: the scheme, a space, then the credential's slot (`{credential}`, `$TOKEN`,
 * a `${}` slot, or the end of a literal another value is joined onto). Prose such as "Basic usage" is not one. */
const PREFIX = /^(?:Bearer|Basic) (?:[{$]|$)/
const MESSAGE =
	"credential placement comes from the operation's OpenAPI security (src/spec/security/); do not name an auth header or scheme prefix here"

interface Quasi extends Node {
	value: { cooked?: string | null }
}

const names = (text: string): boolean => HEADERS.has(text.toLowerCase()) || PREFIX.test(text)

export const rule: Rule = {
	create(context: Context) {
		const file = repoPath(context.filename)
		if (!file.includes("/src/") || isTestCode(file) || HOMES.some((home) => file.includes(home))) return {}
		return {
			Literal(node: Literal) {
				if (typeof node.value === "string" && names(node.value)) context.report({ message: MESSAGE, node })
			},
			TemplateElement(node: Quasi) {
				if (names(node.value.cooked ?? "")) context.report({ message: MESSAGE, node })
			},
		}
	},
}
