import { describe, expect, it } from "vitest"
import { posterStyle } from "./style.ts"

describe("posterStyle", () => {
	it("is one sheet that lays the entity cards out in as many columns as entities, up to five", () => {
		const sheet = posterStyle(2)
		expect(sheet.startsWith("  :root {\n    --bg: #243044;")).toBe(true)
		expect(sheet.endsWith("  footer code { color: var(--ink); }\n")).toBe(true)
		expect(sheet).toContain(
			"  .crowd-note { margin-top: 16px; color: var(--mute); }\n  .cards { display: grid; grid-template-columns: repeat(2, minmax(200px, 1fr));",
		)
		expect(sheet).toContain("border: 1px solid var(--line); }\n  .card { background: var(--card);")
		expect(posterStyle(9)).toContain("repeat(5, minmax(200px, 1fr))")
	})
})
