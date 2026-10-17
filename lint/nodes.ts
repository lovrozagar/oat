import type { Literal, Member } from "./ast.ts"

/** The name a member expression reads, written `a.name` or `a["name"]`; "" when the key is computed. */
export function propertyName(member: Member): string {
	/* Uncomputed, the property is an Identifier or a PrivateIdentifier, and both carry a name. */
	if (member.computed !== true) return (member.property as { name: string }).name
	const value = (member.property as Literal).value
	return typeof value === "string" ? value : ""
}
