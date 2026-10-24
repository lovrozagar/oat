import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { toCurl } from "../../src/client/curl.ts"
import type { Exchange } from "../../src/runtime/exchange.ts"
import { Redactor } from "../../src/security/redact.ts"

/*
 * A TOTP setup answer carries its secret three ways: under `secret`, inside an otpauth URI, and drawn
 * as a QR image. Once a run has seen the answer, no serializer a saved exchange, report or repro goes
 * through may show the secret in any form: raw, spaced or lowercased as shown, base32-normalized, or
 * URL-encoded inside another URL.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/* A secret as an otpauth URI carries it, and as a setup answer may show it. */
const secrets = fc
	.record({
		chars: fc.array(fc.constantFrom(...BASE32), { maxLength: 64, minLength: 16 }),
		lower: fc.boolean(),
		padded: fc.boolean(),
		spaced: fc.boolean(),
	})
	.map(({ chars, lower, padded, spaced }) => {
		const normal = chars.join("")
		let shown = spaced ? (normal.match(/.{1,4}/g) ?? []).join(" ") : normal
		if (lower) shown = shown.toLowerCase()
		if (padded) shown = `${shown}====`
		return { normal, shown }
	})

function setupAnswer(normal: string, shown: string, uriFirst: boolean): Record<string, string> {
	const uri = `otpauth://totp/oat:ada?secret=${normal}&issuer=oat`
	const qr = `data:image/png;base64,${Buffer.from(uri).toString("base64")}`
	return uriFirst ? { otpauth_uri: uri, qr_code: qr, secret: shown } : { secret: shown, qr_code: qr, otpauth_uri: uri }
}

/* Everything every serializer wrote once the redactor saw the answer. */
function serialized(answer: Record<string, string>, normal: string): string {
	const redactor = new Redactor()
	const uri = answer["otpauth_uri"] ?? ""
	const exchange = {
		method: "POST",
		requestBody: { code: normal, note: uri },
		requestHeaders: { "x-echo": normal },
		url: `https://h.test/v1/verify?u=${encodeURIComponent(uri)}&s=${normal}`,
	} as unknown as Exchange
	/* What the journal does with a response before it writes anything. */
	redactor.learn(answer)
	return [
		JSON.stringify(redactor.json(answer)),
		JSON.stringify(redactor.body(answer, "application/json")),
		redactor.text(`${normal} ${uri}`),
		redactor.url(exchange.url),
		JSON.stringify(redactor.headers(exchange.requestHeaders)),
		toCurl(exchange, { redactor }),
	].join("\n")
}

/* Every form the secret could be written in. */
function forms(normal: string, shown: string): string[] {
	return [...new Set([normal, shown, normal.toLowerCase(), encodeURIComponent(normal), encodeURIComponent(shown)])]
}

describe("a TOTP secret the backend issues", () => {
	it("survives no serializer, in any form, whatever its case, padding, spacing or the answer's key order", () => {
		fc.assert(
			fc.property(secrets, fc.boolean(), ({ normal, shown }, uriFirst) => {
				const out = serialized(setupAnswer(normal, shown, uriFirst), normal)
				expect(forms(normal, shown).filter((form) => out.includes(form))).toEqual([])
			}),
			{ numRuns: 1000 },
		)
	})

	it("is scrubbed when it is 16 letters alone", () => {
		const normal = "ABCDEFGHIJKLMNOP"
		const out = serialized(setupAnswer(normal, normal, true), normal)
		expect(out.includes(normal)).toBe(false)
	})
})
