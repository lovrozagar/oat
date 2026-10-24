/**
 * `auth.setup2fa` under the totp-setup shape: the caller enrolls TOTP and is answered its secret three
 * ways, as real backends do: the base32 secret, the otpauth URI that carries it, and a QR image of that
 * URI. Each call issues a fresh secret, kept in the state so a test can look for it in what a run saved.
 */

import { randomBytes } from "node:crypto"
import { authenticate } from "../auth/credentials.ts"
import type { ReferenceState } from "../state.ts"
import { type ReferenceRequest, type ReferenceResponse, respond } from "../wire.ts"

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/* The PNG file signature: the image a QR encoder would draw starts with it. */
const PNG_SIGNATURE = /* @__PURE__ */ Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/* 20 random bytes as 32 base32 characters, the RFC 4226 recommended secret length. */
function base32Secret(): string {
	let bits = ""
	for (const byte of randomBytes(20)) bits += byte.toString(2).padStart(8, "0")
	return Array.from({ length: 32 }, (_, at) => BASE32[Number.parseInt(bits.slice(at * 5, at * 5 + 5), 2)]).join("")
}

/* A stand-in for the QR image: the PNG signature, then the URI it would draw. */
function qrImage(uri: string): string {
	const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from(uri, "utf8")])
	return `data:image/png;base64,${bytes.toString("base64")}`
}

export async function totp(state: ReferenceState, request: ReferenceRequest): Promise<ReferenceResponse | undefined> {
	if (state.shape.totpSetup !== true || request.url.pathname !== "/v1/me/2fa" || request.method !== "POST") {
		return undefined
	}
	const principal = authenticate(state, request)
	const secret = base32Secret()
	state.totpSecrets.push(secret)
	const otpauthUri = `otpauth://totp/oat-reference:${principal.key}?secret=${secret}&issuer=oat-reference`
	return respond(200, { otpauth_uri: otpauthUri, qr_code: qrImage(otpauthUri), secret })
}
