import { JOB } from "./job.ts"
import { ROW } from "./row.ts"
import { TABLE } from "./table.ts"
import type { EntityDef } from "./types.ts"
import { WEBHOOK } from "./webhook.ts"

/** Every entity the reference serves, parents before children. */
export const ENTITIES: readonly EntityDef[] = [TABLE, ROW, JOB, WEBHOOK]
