/**
 * The oldest Node oat supports, as `major.minor`: the first release where `node:sqlite`, a `.ts`
 * config and the QUERY method all work under plain `node`, the way the published binary runs.
 * `package.json` `engines.node` is `>=` this `.0`, and every message that names the floor reads it
 * from here (tests/structure/engines.test.ts holds them together).
 */
export const NODE_FLOOR = "22.18"
