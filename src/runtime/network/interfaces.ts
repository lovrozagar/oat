/** Whether this machine has a link at all: a failure with no usable interface is "offline". */

import { networkInterfaces, type NetworkInterfaceInfo } from "node:os"
import type { NetworkKind } from "../../errors/network.ts"

export function refineNetworkKind(
	kind: NetworkKind,
	read: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces,
): NetworkKind {
	if (kind === "offline") return kind
	return hasUsableInterface(read) ? kind : "offline"
}

export function hasUsableInterface(read: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces): boolean {
	for (const list of Object.values(read())) {
		for (const info of list ?? []) {
			if (!info.internal && info.address !== "") return true
		}
	}
	return false
}
