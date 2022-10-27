import { Runnable, RunnableArgs, Running } from './Runnable'
import { abortableTimeout } from './utils'

export type SupervisorOptions = {
	restart?: boolean | {
		max?: number
		minBackoff?: number
		maxBackoff?: number
		exponentiationBase?: number
	}
}

export class Supervisor implements Runnable {
	constructor(
		private runnable: Runnable,
		private options: SupervisorOptions,
	) {
	}

	public async run(args: RunnableArgs): Promise<Running> {
		const { logger, onError } = args
		let restartCount = 0
		const restart = this.options.restart === true ? {} : (this.options.restart ?? false)
		const abortController = new AbortController()
		let innerRunning: Running | undefined

		await new Promise<void>(async (resolve, reject) => {
			while (!abortController.signal.aborted) {
				try {
					// eslint-disable-next-line promise/param-names
					await new Promise<void>(async (innerResolve, innerReject) => {
						innerRunning = await this.runnable.run({
							onClose: innerResolve,
							onError: innerReject,
							logger: logger.child({ runningId: Math.random().toString().substring(2) }),
						})
						restartCount = 0
						resolve()
					})
				} catch (e) {
					innerRunning = undefined
					if (restart && (!restart.max || restartCount++ < restart.max)) {
						const timeoutMs = Math.min(
							Math.pow(restart.exponentiationBase ?? 2, restartCount - 1) * (restart.minBackoff ?? 1_000),
							restart.maxBackoff ?? 60_000,
						)
						logger.error(`Runnable crashed, restarting in ${timeoutMs} ms ...`, {
							error: e,
						})
						await abortableTimeout(timeoutMs, abortController.signal)
						logger.info(`Restarting runnable now`)
					} else {
						logger.error(`Runnable crashed, stopping`, {
							error: e,
						})
						reject(e)
						onError(e)
					}
				}
			}
		})

		return {
			async end(): Promise<void> {
				abortController.abort()
				await innerRunning?.end()
			},
		}
	}
}
