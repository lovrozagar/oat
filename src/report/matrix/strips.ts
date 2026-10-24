/** The poster's strips: every cataloged check of the focus entity as a chip, grouped by strip. */

import { STRIPS } from "./catalog.ts"
import { nodeOf } from "./slice.ts"
import { esc } from "./text.ts"
import type { EntityMatrix } from "./types.ts"

/** With several entities on the poster, only the chips that failed or stood down. */
export function stripHtml(focus: EntityMatrix, multi: boolean): string {
	return STRIPS.map((strip) => {
		const chips = strip.ids
			.map((id) => {
				const node = nodeOf(focus, id)
				if (multi && node.status !== "failed" && node.status !== "blocked") return ""
				const short = id.split(".").slice(1).join(".")
				const title = node.because !== undefined ? `${id} — waiting on ${node.because}` : id
				return `<span class="chip ${node.status}" title="${esc(title)}">${esc(short)}</span>`
			})
			.join("")
		if (chips === "") return ""
		return `<div class="strip"><div class="strip-title">${esc(strip.title)}</div><div class="chips">${chips}</div></div>`
	}).join("")
}
