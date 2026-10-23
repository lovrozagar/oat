/** The checks an oat tag's value is held to: each returns what is wrong with it, or `null`. */

export type Check = (value: unknown) => string | null

/** A tag object's fields, each with the check its value must pass. */
export type Fields = Readonly<Record<string, Check>>

/** The checks for a tag shaped like `T`: only `T`'s keys, so a misspelled one does not compile. */
export type FieldsOf<T> = { readonly [K in keyof T]?: Check }

export const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)

const ROUTE = /^[A-Za-z]+\s+\/\S*$/

export const text: Check = (value) => (typeof value === "string" && value !== "" ? null : "must be a non-empty string")
export const flag: Check = (value) => (typeof value === "boolean" ? null : "must be true or false")
export const route: Check = (value) =>
	typeof value === "string" && ROUTE.test(value.trim()) ? null : 'must be a route like "GET /path"'
export const texts: Check = (value) =>
	Array.isArray(value) && value.every((item) => typeof item === "string") ? null : "must be an array of strings"
export const positive: Check = (value) => (typeof value === "number" && value > 0 ? null : "must be a positive number")
export const integer: Check = (value) =>
	typeof value === "number" && Number.isInteger(value) && value > 0 ? null : "must be a positive integer"
export const textMap: Check = (value) =>
	isObject(value) && Object.values(value).every((item) => typeof item === "string") ? null : "must map names to strings"

/** `value` is one of `allowed`. */
export function oneOf(value: unknown, allowed: readonly string[]): string | null {
	return allowed.includes(value as string) ? null : `must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`
}

/** An object with these fields; `required` must be present, the rest are checked when present. */
export function checkShape(value: unknown, fields: Fields, required: readonly string[] = []): string | null {
	if (!isObject(value)) return "must be an object"
	for (const key of required) if (value[key] === undefined) return `needs "${key}"`
	for (const [key, entry] of Object.entries(value)) {
		const check = fields[key]
		if (check === undefined || entry === undefined) continue
		const problem = check(entry)
		if (problem !== null) return `"${key}" ${problem}`
	}
	return null
}

/** One query axis: field names, structured rows, or `null` for an explicit "none". */
export function checkAxis(value: unknown, row: Fields): string | null {
	if (value === null) return null
	if (!Array.isArray(value)) return "must be an array of field names or { field } rows"
	for (const item of value) {
		if (typeof item === "string") continue
		const problem = checkShape(item, row, ["field"])
		if (problem !== null) return `has a row that ${problem}`
	}
	return null
}
