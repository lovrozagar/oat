import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { report } from "../../report/console/report.ts"
import { authStepOperationIds } from "../../runtime/scope/entities.ts"
import type { Args } from "../flags.ts"
import type { Writer } from "../writer.ts"
import { modelled } from "./spec.ts"

/** `oat doctor`: what oat can and cannot test in the document, and why. Exits 1 on anything blocking. */
export async function commandDoctor(writer: Writer, flags: Args["flags"]): Promise<number> {
	const read = await modelled(writer, flags)
	if (typeof read === "number") return read
	const { model, externalRefs, config, configPath, removed } = read
	const output = report.doctor(model, {
		asJson: flags.json === true,
		config:
			config === undefined
				? undefined
				: {
						...(config.query === undefined ? {} : { query: config.query }),
						...(config.entities === undefined ? {} : { entities: config.entities }),
						...(config.hooks === undefined ? {} : { hooks: config.hooks }),
						...(config.allow === undefined ? {} : { allowRemoved: removed }),
						authCreates: authStepOperationIds(config),
					},
		externalRefs,
	})
	writer.out(output.text)
	/* A baseline that is not there makes every known finding fail the next run. */
	if (config?.baseline !== undefined && configPath !== undefined) {
		const path = resolve(dirname(resolve(configPath)), config.baseline)
		if (!existsSync(path)) writer.out(`  baseline   ${path} does not exist; \`oat baseline --from <run>\` writes one\n`)
	}
	return output.blocking > 0 ? 1 : 0
}
