/** Route references (`GET /things/{id}`) and the path templates they name. */

/** Normalises `/things/:id` to `/things/{id}` so both path syntaxes compare equal. */
export function normalisePath(path: string): string {
	return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")
}

/** `"GET /things/:id"` → `{ method: "GET", path: "/things/{id}" }` */
export function parseRouteRef(ref: string): { method: string; path: string } | null {
	const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(ref)
	if (match === null) return null
	const [, method, path] = match as unknown as [string, string, string]
	return { method: method.toUpperCase(), path: normalisePath(path) }
}

/** `{param}` and `:param` segments match one path component. */
export function pathTemplateMatches(template: string, pathname: string): boolean {
	return pathTemplateParams(template, pathname) !== null
}

/**
 * The value each `{param}` (or `:param`) segment of `template` takes in `pathname`, URI-decoded;
 * `null` when the path is not an instance of the template.
 */
export function pathTemplateParams(template: string, pathname: string): Record<string, string> | null {
	const names: string[] = []
	const compiled = normalisePath(template)
		.split("/")
		.map((segment) => {
			if (segment.startsWith("{") && segment.endsWith("}")) {
				names.push(segment.slice(1, -1))
				return "([^/]+)"
			}
			return segment.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		})
		.join("/")
	const match = new RegExp(`^${compiled}$`).exec(pathname)
	if (match === null) return null
	return Object.fromEntries(names.map((name, index) => [name, decodePathValue(match[index + 1] as string)]))
}

/** A path segment as it was meant: percent-decoded, or as sent when it is not valid encoding. */
function decodePathValue(segment: string): string {
	try {
		return decodeURIComponent(segment)
	} catch {
		return segment
	}
}
