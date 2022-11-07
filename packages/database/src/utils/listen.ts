import { Client, Connection } from '../client'
import { wrapIdentifier } from './sql'

type ListenArgs = {
	client: Client<Connection.AcquiredConnectionLike>
	channel: string
	abortSignal?: AbortSignal
	healthCheckMs?: number
	onMessage: (payload: string | undefined) => void
	onError: (err: any) => void
}
export const listen = async ({ abortSignal, channel, client, healthCheckMs, onError, onMessage }: ListenArgs): Promise<void> => {
	if (abortSignal?.aborted) {
		return
	}
	await client.query(`LISTEN ${wrapIdentifier(channel)}`)
	const removeListener = client.connection.on('notification', ({ channel: notificationChannel, payload }) => {
		if (notificationChannel !== channel || abortSignal?.aborted) {
			return
		}
		onMessage(payload)
	})


	;(async () => {
		let healthCheckHandle
		try {
			const abortHandler = async () => {
				try {
					await client.query(`UNLISTEN ${wrapIdentifier(channel)}`)
				} catch {
				}
			}
			if (abortSignal?.aborted) {
				await abortHandler()
				return
			}
			abortSignal?.addEventListener('abort', abortHandler)

			await new Promise<void>((resolve, reject) => {

				client.connection.on('end', resolve)
				client.connection.on('error', reject)

				healthCheckHandle = setInterval(async () => {
					try {
						await client.query('SELECT 1')
					} catch (e) {
						reject(e)
					}
				}, healthCheckMs ?? 5_000)
			})
		} catch (e) {
			onError(e)
		} finally {
			removeListener()
			if (healthCheckHandle) {
				clearInterval(healthCheckHandle)
			}
		}
	})()
}
