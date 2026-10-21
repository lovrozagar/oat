/*
 * The principal a dedicated credential is held under: `<owner>#probe-<n>`. The store enrolls it so
 * the credential is never the owner's own session; nothing else ever sees it. An exchange, a finding
 * or a teardown record names the owner instead, so no file a run writes carries a probe's id.
 */

const SUFFIX = /#probe-\d+$/

/** The `n`th probe principal of `owner`. */
export function probePrincipal(owner: string, n: number): string {
	return `${owner}#probe-${n}`
}

/** The principal a probe principal was made for; any other principal is its own. */
export function probeOwner(principal: string): string {
	return principal.replace(SUFFIX, "")
}

/** `text` with every probe principal named by its owner: what a reason a report carries must say. */
export function withoutProbes(text: string): string {
	return text.replaceAll(/#probe-\d+/g, "")
}

/** Whether `principal` is a dedicated credential's probe principal. */
export function isProbePrincipal(principal: string): boolean {
	return SUFFIX.test(principal)
}
