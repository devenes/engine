import { DatabaseContext } from '@contember/engine-system-api'
import { EventDispatcher } from './EventDispatcher'
import { ContentSchemaResolver } from '@contember/engine-http'
import { Runnable, RunnableArgs, Running } from '@contember/engine-common'
import { listen } from '@contember/database'
import { NOTIFY_CHANNEL_NAME } from '../triggers/TriggerPayloadPersister'


export class DispatchRunnableFactory {
	constructor(
		private readonly dispatcher: EventDispatcher,
	) {
	}

	public create({ db, contentSchemaResolver }: { db: DatabaseContext; contentSchemaResolver: ContentSchemaResolver}): DispatchRunnable {
		return new DispatchRunnable(this.dispatcher, db, contentSchemaResolver)
	}
}



export class DispatchRunnable implements Runnable {
	constructor(
		private readonly dispatcher: EventDispatcher,
		private readonly db: DatabaseContext,
		private readonly contentSchemaResolver: ContentSchemaResolver,
	) {
	}

	public async run({ logger, onError, onClose }: RunnableArgs): Promise<Running> {
		const abortController = new AbortController()

		return await new Promise<Running>(async (resolve, reject) => {

			let resolvePending = () => {}
			let rejectPending = (e: any) => {}

			const resolvePendingRef = () => {
				resolvePending()
			}
			let pendingError: any = undefined
			const rejectPendingRef = (e: any) => {
				pendingError = e
				rejectPending(e)
			}

			let succeedTotal = 0
			let failedTotal = 0

			abortController.signal.addEventListener('abort', resolvePendingRef)
			try {
				await this.db.scope(async db => {
					try {
						await listen({
							client: db.client,
							channel: NOTIFY_CHANNEL_NAME,
							abortSignal: abortController.signal,
							onError: rejectPendingRef, // abort loop
							onMessage: resolvePendingRef, // wake up waiting loop
						})

						resolve({
							end: async () => {
								abortController.abort()
								logger.info('Worker terminated', {
									succeed: succeedTotal,
									failed: failedTotal,
								})
							},
						})
					} catch (e) {
						reject(e)
						return
					}

					try {
						while (!abortController.signal.aborted) {
							const { succeed, failed, backoffMs } = await this.dispatcher.processBatch({
								db,
								contentSchemaResolver: this.contentSchemaResolver,
								logger,
							})
							succeedTotal += succeed
							failedTotal += failed

							// listener error occurred during batch processing, rethrow
							if (pendingError) {
								throw pendingError
							}

							// queue is empty, wait
							if (backoffMs !== 0) {
								await new Promise<void>((resolve, reject) => {
									let cleanup = () => {
									}
									if (backoffMs !== undefined) {
										const timeoutHandle = setTimeout(resolve, backoffMs)
										cleanup = () => clearTimeout(timeoutHandle)
									}
									resolvePending = () => {
										resolve()
										cleanup()
									}
									rejectPending = e => {
										reject(e)
										cleanup()
									}
								})
							}
						}
						onClose?.()
					} catch (e) {
						onError(e)
					}
				})
			} finally {
				abortController.signal.removeEventListener('abort', resolvePendingRef)
			}
		})


	}
}
