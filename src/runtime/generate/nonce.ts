/** A nonce folded into a non-negative 32-bit number, for values that must be numeric. */
export function nonceNumber(nonce: string): number {
	let h = 0
	for (const ch of nonce) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0
	return h
}
