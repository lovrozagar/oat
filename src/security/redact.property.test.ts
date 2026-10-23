import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { REDACTED, Redactor } from "./redact.ts"

/*
 * The redactor over arbitrary text, URLs, JSON and forms. Secrets come from the alphabet issued
 * credentials use (base64, base64url, JWT), at least six characters, as `registerSecret` takes them.
 * A secret that is itself a piece of `<redacted>` would match the marker it leaves, so none is.
 */

const FORM = "application/x-www-form-urlencoded"

const secret = fc.stringMatching(/^[A-Za-z0-9+/=._~-]{6,20}$/).filter((value) => !REDACTED.includes(value))
const secrets = fc.uniqueArray(secret, { maxLength: 3, minLength: 1 })
const around = fc.string({ maxLength: 12 })
/* Names too short to hold a secret, so a key never carries one by accident. */
const shortName = fc.stringMatching(/^[a-z]{1,5}$/)
const secretKey = fc.constantFrom("password", "api_key", "refreshToken", "session_id", "client_secret", "Cookie")

const redactorOf = (values: readonly string[]): Redactor => {
	const redactor = new Redactor()
	for (const value of values) redactor.registerSecret(value)
	return redactor
}

/* Every form a secret can be written in that the redactor's callers send. */
const forms = (value: string): string[] => [
	value,
	encodeURIComponent(value),
	new URLSearchParams({ v: value }).toString().slice(2),
]
const leaks = (out: string, values: readonly string[]): string[] =>
	values.flatMap(forms).filter((form) => out.includes(form))

/* Text with each secret embedded once, among arbitrary text. */
const embedded = fc
	.tuple(secrets, fc.array(around, { maxLength: 4, minLength: 4 }))
	.map(([values, pads]) => ({ text: pads.map((pad, i) => pad + (values[i] ?? "")).join(""), values }))

describe("Redactor.text, by property", () => {
	it("never prints a registered secret, whatever text surrounds it", () => {
		fc.assert(
			fc.property(embedded, ({ text, values }) => {
				const out = redactorOf(values).text(text)
				for (const value of values) expect(out).not.toContain(value)
			}),
		)
	})

	it("scrubs a scheme-prefixed credential's bare token too", () => {
		fc.assert(
			fc.property(fc.constantFrom("Bearer", "Token", "ApiKey"), secret, around, (scheme, token, pad) => {
				expect(redactorOf([`${scheme} ${token}`]).text(pad + token + pad)).not.toContain(token)
			}),
		)
	})

	it("ignores a value shorter than six characters once trimmed", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 5 }), fc.string(), (short, text) => {
				expect(redactorOf([` ${short} `]).text(text)).toBe(text)
			}),
		)
	})

	it("is idempotent", () => {
		fc.assert(
			fc.property(embedded, ({ text, values }) => {
				const redactor = redactorOf(values)
				expect(redactor.text(redactor.text(text))).toBe(redactor.text(text))
			}),
		)
	})

	it("redacts a registered cookie's value in any cookie list", () => {
		fc.assert(
			fc.property(shortName, secret, fc.constantFrom("; ", ", ", " ", ";"), (name, value, sep) => {
				const redactor = new Redactor()
				redactor.registerCookie(name)
				/* Filler names with a digit, which `shortName` never draws. */
				const out = redactor.text(`o1=1${sep}${name}=${value}${sep}o2=2`)
				expect(out).toBe(`o1=1${sep}${name}=${REDACTED}${sep}o2=2`)
			}),
		)
	})
})

describe("Redactor.url, by property", () => {
	const url = fc.record({
		echo: shortName,
		named: fc.option(fc.oneof(secretKey, shortName), { nil: undefined }),
		pad: shortName,
		values: secrets,
	})

	it("prints no registered secret, raw or encoded, in the path or the query", () => {
		fc.assert(
			fc.property(url, ({ echo, named, pad, values }) => {
				const redactor = redactorOf(values)
				if (named !== undefined) redactor.registerQuery(named)
				const query = new URLSearchParams(values.map((value): [string, string] => [echo, pad + value]))
				if (named !== undefined) query.append(named, pad)
				const out = redactor.url(`https://x.test/${values.join("/")}/${pad}?${query}`)
				expect(leaks(out, values)).toEqual([])
				const placed = named === undefined ? REDACTED : new URL(out).searchParams.get(named)
				expect(placed).toBe(REDACTED)
			}),
		)
	})
})

/* A JSON tree of short keys, with secrets embedded in some of its strings. */
const tree = (values: readonly string[]) => {
	const text = fc.oneof(
		around,
		fc.tuple(around, fc.constantFrom(...values), around).map((parts) => parts.join("")),
	)
	return fc.letrec<{ node: unknown }>((tie) => ({
		node: fc.oneof(
			{ depthSize: "small", withCrossShrink: true },
			text,
			fc.integer(),
			fc.boolean(),
			fc.constant(null),
			fc.array(tie("node"), { maxLength: 3 }),
			fc.dictionary(shortName, tie("node"), { maxKeys: 3, noNullPrototype: true }),
		),
	})).node
}

describe("Redactor.json, by property", () => {
	const withTree = secrets.chain((values) => fc.tuple(fc.constant(values), tree(values)))

	it("prints no registered secret anywhere in a JSON value", () => {
		fc.assert(
			fc.property(withTree, ([values, value]) => {
				expect(leaks(JSON.stringify(redactorOf(values).json(value)) ?? "", values)).toEqual([])
			}),
		)
	})

	it("redacts a secret-family key whatever it holds, and is idempotent", () => {
		fc.assert(
			fc.property(withTree, secretKey, ([values, value], key) => {
				const redactor = redactorOf(values)
				const out = redactor.json({ [key]: value, keep: value })
				expect(out).toEqual({ [key]: REDACTED, keep: redactor.json(value) })
				expect(redactor.json(out)).toEqual(out)
			}),
		)
	})
})

describe("Redactor.textBody and headers, by property", () => {
	const field = fc.tuple(shortName, around, fc.boolean())

	it("prints no registered secret from a form, raw or encoded", () => {
		fc.assert(
			fc.property(secrets, fc.array(field, { maxLength: 4 }), (values, fields) => {
				const redactor = redactorOf(values)
				const pairs = values.map((value, i) => {
					const [name, pad, form] = fields[i] ?? ["f", "", false]
					const encoded = form
						? new URLSearchParams({ v: pad + value }).toString().slice(2)
						: encodeURIComponent(pad + value)
					return `${name}=${encoded}`
				})
				const out = redactor.textBody(pairs.join("&"), FORM)
				expect(leaks(out, values)).toEqual([])
				expect(redactor.textBody(out, FORM)).toBe(out)
			}),
		)
	})

	it("redacts a registered header in any casing, keeping only Authorization's scheme word", () => {
		const casing = fc.constantFrom(
			(n: string) => n,
			(n: string) => n.toUpperCase(),
			(n: string) => n.toLowerCase(),
		)
		fc.assert(
			fc.property(fc.constantFrom("X-Tenant", "Authorization"), casing, secret, (name, recase, value) => {
				const redactor = new Redactor()
				redactor.registerHeader(name)
				const out = redactor.headers({ [recase(name)]: `Bearer ${value}`, accept: value })
				const kept = name === "Authorization" ? `Bearer ${REDACTED}` : REDACTED
				expect(out).toEqual({ [recase(name)]: kept, accept: value })
				expect(redactor.headers(out)).toEqual(out)
			}),
		)
	})
})
