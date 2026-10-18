/** What every entity route works from: the entity, the path's typed scope, and who is asking. */

import type { EntityDef } from "../../model/types.ts"
import type { Principal, Scope } from "../state.ts"

export interface EntityCall {
	entity: EntityDef
	scope: Scope
	principal: Principal
}

export interface ItemCall extends EntityCall {
	itemId: string | number
}
