/** One conformance task per message, in a forked process; see `pool.ts` and `serve-tasks.ts`. */

import { listening } from "./harness/launch.ts"
import { serveTasks } from "./serve-tasks.ts"

serveTasks(process, listening)
