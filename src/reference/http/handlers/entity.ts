/** What every entity route works from: the entity, the path's typed scope, and who is asking. */

import type { Collection, Principal } from "../state.ts"

export interface EntityCall extends Collection {
	principal: Principal
}

export interface ItemCall extends EntityCall {
	itemId: string | number
}
