/**
 * One OAS style/explode serializer for every parameter location: query, path, header, cookie, and a
 * form body's fields. It follows OAS 3.1 §4.8.12.4: query and cookie default to `form`, exploded;
 * path and header to `simple`, not exploded. Every value is percent-encoded per RFC 3986 unless the
 * parameter allows reserved characters; a header is never percent-encoded.
 */

import type { ParamIn, ParamStyle } from "../spec/graph/parameters.ts"

/** A parameter: where it goes, its name, and how the document says to write it. */
export interface StyledParam extends ParamStyle {
	in: ParamIn
	name: string
}

export type Pair = [string, string]

type Encode = (text: string) => string

/* What a value is once each piece is text: one scalar, an array's items, or an object's entries. */
type Shape = { scalar: string } | { items: string[] } | { entries: Pair[] }

/* encodeURIComponent leaves these sub-delims as they are; RFC 3986 reserves them. */
const SUB_DELIMS = /[!'()*]/g
/* Every reserved character, encoded: what `allowReserved` sends as it is. */
const RESERVED = /%(?:3A|2F|3F|23|5B|5D|40|21|24|26|27|28|29|2A|2B|2C|3B|3D)/g

const strict: Encode = (text) =>
	encodeURIComponent(text).replace(SUB_DELIMS, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
const reservedKept: Encode = (text) => strict(text).replace(RESERVED, decodeURIComponent)
const asIs: Encode = (text) => text

function textOf(item: unknown): string {
	return item !== null && typeof item === "object" ? JSON.stringify(item) : String(item)
}

function shapeOf(value: unknown, encode: Encode): Shape {
	if (Array.isArray(value)) return { items: value.map((item) => encode(textOf(item))) }
	if (typeof value !== "object" || value === null) return { scalar: encode(String(value)) }
	const entries = Object.entries(value).filter(([, item]) => item !== undefined)
	return { entries: entries.map(([key, item]): Pair => [encode(key), encode(textOf(item))]) }
}

/* The style and explode a parameter is written with, the document's or the OAS default. deepObject
 * is defined only exploded. */
function resolved(
	param: Pick<StyledParam, "explode" | "in" | "style">,
): Required<Pick<ParamStyle, "explode" | "style">> {
	const style = param.style ?? (param.in === "query" || param.in === "cookie" ? "form" : "simple")
	return { explode: style === "deepObject" || (param.explode ?? style === "form"), style }
}

/* What a non-exploded array or object is joined with. A space cannot go out bare, so it is encoded. */
function delimiterOf(style: string, encode: Encode): string {
	if (style === "spaceDelimited") return encode(" ")
	return style === "pipeDelimited" ? "|" : ","
}

/* Key/value pairs: the form styles, spaceDelimited, pipeDelimited and deepObject. */
function pairsOf(name: string, shape: Shape, how: { style: string; explode: boolean; delimiter: string }): Pair[] {
	if ("scalar" in shape) return [[name, shape.scalar]]
	if ("items" in shape) {
		return how.explode ? shape.items.map((item): Pair => [name, item]) : [[name, shape.items.join(how.delimiter)]]
	}
	if (how.style === "deepObject") return shape.entries.map(([key, item]): Pair => [`${name}[${key}]`, item])
	return how.explode ? shape.entries : [[name, shape.entries.flat().join(how.delimiter)]]
}

const PREFIX: Readonly<Record<string, string>> = { label: ".", matrix: ";" }

/* One string: the simple, label and matrix styles. */
function stringOf(name: string, shape: Shape, { style, explode }: { style: string; explode: boolean }): string {
	const prefix = PREFIX[style] ?? ""
	const matrix = style === "matrix"
	if ("scalar" in shape)
		return matrix ? (shape.scalar === "" ? `;${name}` : `;${name}=${shape.scalar}`) : prefix + shape.scalar
	const pieces =
		"items" in shape ? shape.items : shape.entries.map(([key, item]) => (explode ? `${key}=${item}` : `${key},${item}`))
	if (!explode) return matrix ? `;${name}=${pieces.join(",")}` : prefix + pieces.join(",")
	if (!matrix) return prefix + pieces.join(style === "label" ? "." : ",")
	return pieces.map((piece) => ("items" in shape ? `;${name}=${piece}` : `;${piece}`)).join("")
}

/**
 * `value` as the parameter sends it: key/value pairs for a query or cookie parameter, one string for
 * a path or header parameter. An absent value sends nothing.
 */
export function serializeParam(param: StyledParam & { in: "query" | "cookie" }, value: unknown): Pair[]
export function serializeParam(param: StyledParam & { in: "path" | "header" }, value: unknown): string
export function serializeParam(param: StyledParam, value: unknown): Pair[] | string
export function serializeParam(param: StyledParam, value: unknown): Pair[] | string {
	const how = resolved(param)
	const pairs = param.in === "query" || param.in === "cookie"
	if (value === undefined || value === null) return pairs ? [] : ""
	const encode = param.in === "header" ? asIs : param.allowReserved === true ? reservedKept : strict
	const shape = shapeOf(value, encode)
	if (!pairs) return stringOf(param.name, shape, how)
	return pairsOf(encode(param.name), shape, { ...how, delimiter: delimiterOf(how.style, encode) })
}

/** A form body field's pairs, unencoded: the body's own encoder encodes them. */
export function unencodedPairs(param: ParamStyle & { name: string }, value: unknown): Pair[] {
	const how = resolved({ ...param, in: "query" })
	return pairsOf(param.name, shapeOf(value, asIs), { ...how, delimiter: delimiterOf(how.style, asIs) })
}
