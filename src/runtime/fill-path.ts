import { SeedError } from "./seed-error.ts"

/** A path template with each `{name}` replaced by its value, URI-encoded. A missing value is a seed failure. */
export function fillPath(template: string, values: Record<string, string>): string {
	return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
		const value = values[name]
		if (value === undefined) throw new SeedError(name, `no value for path parameter {${name}}`)
		return encodeURIComponent(value)
	})
}
