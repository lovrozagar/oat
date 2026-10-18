/** `defineConfig`: the typed entry point of a config file. */

import type { OatConfig } from "../types/config.ts"

/**
 * Identity function that gives a config file full type checking and editor completion.
 *
 * ```ts
 * import { defineConfig } from "@lovrozagar/oat"
 *
 * export default defineConfig({
 *   spec: "https://api.example.com/openapi.json",
 *   baseUrl: "https://api.example.com",
 *   principals: [{ id: "alpha", headers: { authorization: `Bearer ${process.env.TOKEN}` } }],
 * })
 * ```
 */
export function defineConfig(config: OatConfig): OatConfig {
	return config
}
