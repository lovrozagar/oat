import { serializeParam } from "../client/param-style.ts"
import type { ParamStyle } from "../spec/graph/parameters.ts"
import { SeedError } from "./seed-error.ts"

/**
 * A path template with each `{name}` replaced by its value, written in the style the operation
 * declares for it (simple unless it says label or matrix) and percent-encoded per RFC 3986. A
 * missing value is a seed failure.
 */
export function fillPath(
	template: string,
	values: Record<string, string>,
	styles: Readonly<Record<string, ParamStyle>> = {},
): string {
	return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
		const value = values[name]
		if (value === undefined) throw new SeedError(name, `no value for path parameter {${name}}`)
		return serializeParam({ ...styles[name], in: "path", name }, value)
	})
}
