import type { DefectName } from "./table.ts"

/**
 * Defects that by design rewrite or remove records nobody asked them to touch. In those cases a
 * damaged pre-existing record is the backend's doing, so conformance does not hold oat to the
 * bystander rule. Empty: no defect does that today, and adding one needs the reason beside it.
 */
export const DAMAGES_BYSTANDERS: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>()
