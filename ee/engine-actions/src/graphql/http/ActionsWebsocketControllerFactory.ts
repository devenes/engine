import { WebSocketController } from '@contember/engine-http'
import { ActionsContextResolver } from './ActionsContextResolver'
import { DispatchWorkerManager } from '../../dispatch/DispatchWorkerManager'
import * as Typesafe from '@contember/typesafe'

const IncomingMessage = Typesafe.discriminatedUnion(
	'type',
	{
		startWorker: Typesafe.object({}),
		stopAllWorkers: Typesafe.object({}),
	},
)
type IncomingMessage = ReturnType<typeof IncomingMessage>
const OutgoingMessage = Typesafe.discriminatedUnion(
	'type',
	{
		error: Typesafe.object({
			message: Typesafe.string,
		}),
		message: Typesafe.object({
			message: Typesafe.string,
		}),
		ready: Typesafe.object({}),

		workerStarted: Typesafe.object({
			workerId: Typesafe.string,
		}),
		workedStopped: Typesafe.object({
			workerId: Typesafe.string,
		}),
		workerCrashed: Typesafe.object({
			workerId: Typesafe.string,
		}),
	},
)

type OutgoingMessage = ReturnType<typeof OutgoingMessage>

export class ActionsWebsocketControllerFactory {
	constructor(
		private readonly debug: boolean,
		private readonly actionsContextResolver: ActionsContextResolver,
		private readonly dispatchWorkerManager: DispatchWorkerManager,
	) {
	}

	create(): WebSocketController {
		return async ctx => {
			const { ws, logger } = ctx
			const projectContextPromise = this.actionsContextResolver.resolve(ctx)
			const abortController = new AbortController()

			const send = (message: OutgoingMessage) => {
				if (this.debug) {
					OutgoingMessage(message)
				}
				ws.send(JSON.stringify(message))
			}

			let workers: { id: string; promise: Promise<void> }[] = []
			const abortListener = async () => {
				send({ type: 'message', message: 'shutting down' })
				await stopAll()
				send({ type: 'message', message: 'closing connection' })
				ws.close(1012) // Service Restart
			}
			ctx.abortSignal.addEventListener('abort', abortListener)

			const stopAll = async () => {
				abortController.abort()
				const currentWorkers = workers.map(it => it.promise.then(() => send({
					type: 'workedStopped',
					workerId: it.id,
				})))
				workers = []
				await Promise.all(currentWorkers)
			}
			send({ type: 'ready' })

			ws.addEventListener('message', async message => {
				let json
				try {
					json = JSON.parse(message.data.toString())
				} catch {
					send({ type: 'error', message: 'Invalid JSON' })
					return
				}
				let data: IncomingMessage
				try {
					data = IncomingMessage(json)
				} catch (e) {
					if (e instanceof Typesafe.ParseError) {
						send({ type: 'error', message: e.message })
						return
					} else {
						throw e
					}
				}


				const { projectContainer } = await projectContextPromise
				const systemDatabase = projectContainer.systemDatabaseContextFactory.create()
				switch (data.type) {
					case 'startWorker':
						const workerId = Math.random().toString().substring(2)
						workers.push({
							id: workerId,
							promise: this.dispatchWorkerManager.run({
								abortSignal: abortController.signal,
								logger: logger.child({ workerId }),
								contentSchemaResolver: projectContainer.contentSchemaResolver,
								db: systemDatabase,
								restart: {
									max: 10,
								},
							}).catch(() => {
								send({ type: 'workerCrashed', workerId })
							}),
						})
						send({ type: 'workerStarted', workerId })
						break
					case 'stopAllWorkers':
						send({ type: 'message', message: 'stopping' })
						await stopAll()
						send({ type: 'message', message: 'all stopped' })
						break
				}
			})

			const pingHandle = setInterval(() => {
				ws.ping()
			}, 5000)
			ws.addEventListener('close', async () => {
				ctx.abortSignal.removeEventListener('abort', abortListener)
				clearInterval(pingHandle)
				await stopAll()
			})
		}
	}
}

