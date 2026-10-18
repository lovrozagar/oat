/** A value for each string `format` oat knows, deterministic in the variant, index and nonce. */

import { slug } from "./text.ts"
import type { Context } from "./types.ts"

/** A deterministic v4-shaped UUID from a salt. */
export function uuidFrom(salt: string): string {
	let h = 0x811c9dc5
	const hex: string[] = []
	for (let round = 0; hex.join("").length < 32; round++) {
		for (const ch of `${salt}:${round}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0
		hex.push(h.toString(16).padStart(8, "0"))
	}
	const s = hex.join("").slice(0, 32)
	/* Four rounds of eight hex digits: the string is 32 long, so position 16 is there. */
	const variant = "89ab"[Number.parseInt(s[16] as string, 16) % 4]
	return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${variant}${s.slice(17, 20)}-${s.slice(20, 32)}`
}

function pad(n: number): string {
	return String(n).padStart(2, "0")
}

/** What every format draws on, worked out once. */
interface Parts {
	i: number
	salt: string
	slug: string
	/** `-<nonce>` when the value must be distinct and there is a nonce; otherwise empty. */
	tail: string
	date: string
	time: string
}

function partsOf(ctx: Context, distinct: boolean): Parts {
	const i = ctx.index
	const first = ctx.variant === "lexical-first" || ctx.variant === "boundary"
	const last = ctx.variant === "lexical-last"
	const year = first ? 2000 : last ? 2099 : 2024
	const month = first ? 1 : last ? 12 : (i % 12) + 1
	const day = first ? 1 : last ? 28 : (i % 28) + 1
	return {
		date: `${year}-${pad(month)}-${pad(day)}`,
		i,
		salt: `${ctx.variant}:${i}${distinct ? `:${ctx.nonce ?? ""}` : ""}`,
		slug: slug(ctx.variant),
		tail: distinct && ctx.nonce !== undefined ? `-${ctx.nonce}` : "",
		time: `${pad(10 + (i % 12))}:${pad((i * 7) % 60)}:00Z`,
	}
}

type Maker = (parts: Parts) => string

const email: Maker = (p) => `oat-${p.slug}-${p.i}${p.tail}@example.test`
const uri: Maker = (p) => `https://example.test/${p.slug}-${p.i}${p.tail}`
const hostname: Maker = (p) => `host-${p.i}${p.tail}.example.test`

const FORMATS: Readonly<Record<string, Maker>> = {
	byte: (p) => Buffer.from(`oat ${p.i}`).toString("base64"),
	date: (p) => p.date,
	"date-time": (p) => `${p.date}T${p.time}`,
	email,
	hostname,
	"idn-email": email,
	"idn-hostname": hostname,
	ipv4: (p) => `192.0.2.${(p.i % 250) + 1}`,
	ipv6: (p) => `2001:db8::${(p.i % 250) + 1}`,
	iri: uri,
	"iri-reference": uri,
	time: (p) => p.time,
	uri,
	"uri-reference": uri,
	url: uri,
	uuid: (p) => uuidFrom(p.salt),
}

/** A value for each `format` oat knows; `undefined` for one it does not. */
export function formatted(format: string, ctx: Context, distinct: boolean): string | undefined {
	return Object.hasOwn(FORMATS, format) ? (FORMATS[format] as Maker)(partsOf(ctx, distinct)) : undefined
}
