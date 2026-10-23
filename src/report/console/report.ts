/** Console renderers for the offline commands: `doctor` and `plan`. */

import { doctor } from "./doctor.ts"
import { plan } from "./plan.ts"

export const report: { doctor: typeof doctor; plan: typeof plan } = { doctor, plan }
