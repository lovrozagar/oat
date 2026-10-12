/**
 * A software passkey: a real ES256 key pair, an `attestationObject` of fmt "none", and assertion
 * signatures, built from the WebAuthn spec. It answers what a platform authenticator would, with
 * user verification. The origin is the caller's; this file does not name a product.
 */
import { createHash, randomBytes } from "node:crypto"

const FLAG_USER_PRESENT = 0x01
const FLAG_USER_VERIFIED = 0x04
const FLAG_BACKUP_ELIGIBLE = 0x08
const FLAG_BACKED_UP = 0x10
const FLAG_ATTESTED_DATA = 0x40

function b64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url")
}

/* ArrayBuffer-backed, as WebCrypto requires */
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(Buffer.concat(parts))
}

function sha256(data: Uint8Array | string): Uint8Array {
	return Uint8Array.from(createHash("sha256").update(data).digest())
}

function uint32(value: number): Uint8Array {
	const out = Buffer.alloc(4)
	out.writeUInt32BE(value)
	return Uint8Array.from(out)
}

/* minimal CBOR (RFC 8949): what attestation objects and COSE keys need */
function cborHead(major: number, length: number): Uint8Array {
	if (length < 24) return Uint8Array.of((major << 5) | length)
	if (length < 0x100) return Uint8Array.of((major << 5) | 24, length)
	return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff)
}

type Cbor = Uint8Array | number | string | Map<Cbor, Cbor>

function cbor(value: Cbor): Uint8Array {
	if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value)
	if (typeof value === "string") {
		const text = new TextEncoder().encode(value)
		return concat(cborHead(3, text.length), text)
	}
	if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value)
	const entries = [...value].flatMap(([key, item]) => [cbor(key), cbor(item)])
	return concat(cborHead(5, value.size), ...entries)
}

/* WebCrypto signs ECDSA as raw r||s; WebAuthn wants ASN.1 DER */
function derSignature(raw: Uint8Array): Uint8Array<ArrayBuffer> {
	const integer = (bytes: Uint8Array) => {
		let start = 0
		while (start < bytes.length - 1 && bytes[start] === 0) start++
		let body = bytes.slice(start)
		if ((body[0] ?? 0) & 0x80) body = concat(Uint8Array.of(0), body)
		return concat(Uint8Array.of(0x02, body.length), body)
	}
	const r = integer(raw.slice(0, 32))
	const s = integer(raw.slice(32))
	return concat(Uint8Array.of(0x30, r.length + s.length), r, s)
}

/* the parts of the server's options a soft authenticator reads */
type RegistrationOptions = { challenge: string; user: { id: string } }
type AssertionOptions = { challenge: string }

/** The server's passkey registration options, checked (they arrive as untyped JSON). */
function readRegistrationOptions(value: Record<string, unknown>): RegistrationOptions {
	const { challenge, user } = value
	const userId = typeof user === "object" && user !== null && "id" in user ? user.id : undefined
	if (typeof challenge !== "string" || typeof userId !== "string") {
		throw new Error(`not passkey registration options: ${JSON.stringify(value)}`)
	}
	return { challenge, user: { id: userId } }
}

/** The server's passkey sign-in / re-auth options, checked. */
function readAssertionOptions(value: Record<string, unknown>): AssertionOptions {
	const { challenge } = value
	if (typeof challenge !== "string") {
		throw new Error(`not passkey assertion options: ${JSON.stringify(value)}`)
	}
	return { challenge }
}

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string) {
	return new TextEncoder().encode(JSON.stringify({ challenge, crossOrigin: false, origin, type }))
}

type SigningKeys = Awaited<ReturnType<typeof crypto.subtle.generateKey>>

function createSoftAuthenticator(config: { origin: string; rpId: string }) {
	const credentialId = Uint8Array.from(randomBytes(16))
	let keys: SigningKeys | null = null
	let userHandle = ""
	let counter = 0

	async function register(options: RegistrationOptions, overrides: { origin?: string } = {}) {
		const generated = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])
		if (!("publicKey" in generated)) throw new Error("passkey key was not a pair")
		keys = generated
		const jwk = await crypto.subtle.exportKey("jwk", generated.publicKey)
		userHandle = options.user.id
		const coseKey = new Map<Cbor, Cbor>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, Uint8Array.from(Buffer.from(String(jwk.x), "base64url"))],
			[-3, Uint8Array.from(Buffer.from(String(jwk.y), "base64url"))],
		])
		const authData = concat(
			sha256(config.rpId),
			Uint8Array.of(
				FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_BACKUP_ELIGIBLE | FLAG_BACKED_UP | FLAG_ATTESTED_DATA,
			),
			uint32(counter),
			new Uint8Array(16) /* aaguid: none */,
			Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff),
			credentialId,
			cbor(coseKey),
		)
		const attestationObject = cbor(
			new Map<Cbor, Cbor>([
				["fmt", "none"],
				["attStmt", new Map()],
				["authData", authData],
			]),
		)
		const clientDataJSON = clientData("webauthn.create", options.challenge, overrides.origin ?? config.origin)
		return {
			clientExtensionResults: {},
			id: b64url(credentialId),
			rawId: b64url(credentialId),
			response: {
				attestationObject: b64url(attestationObject),
				clientDataJSON: b64url(clientDataJSON),
				transports: ["internal"],
			},
			type: "public-key" as const,
		}
	}

	/** Prove the passkey. `counter` lets a test replay an old signature count. */
	async function authenticate(options: AssertionOptions, overrides: { counter?: number; origin?: string } = {}) {
		if (keys === null || !("privateKey" in keys)) throw new Error("register first")
		counter = overrides.counter ?? counter + 1
		const authData = concat(
			sha256(config.rpId),
			Uint8Array.of(FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_BACKUP_ELIGIBLE | FLAG_BACKED_UP),
			uint32(counter),
		)
		const data = clientData("webauthn.get", options.challenge, overrides.origin ?? config.origin)
		const raw = new Uint8Array(
			await crypto.subtle.sign({ hash: "SHA-256", name: "ECDSA" }, keys.privateKey, concat(authData, sha256(data))),
		)
		return {
			clientExtensionResults: {},
			id: b64url(credentialId),
			rawId: b64url(credentialId),
			response: {
				authenticatorData: b64url(authData),
				clientDataJSON: b64url(data),
				signature: b64url(derSignature(raw)),
				userHandle,
			},
			type: "public-key" as const,
		}
	}

	return { authenticate, credentialId: b64url(credentialId), register }
}

export { createSoftAuthenticator, readAssertionOptions, readRegistrationOptions }
