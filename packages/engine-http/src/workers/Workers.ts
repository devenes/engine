export interface Worker {
	start(): Promise<void>
}

export interface RunningWorker {
	isRunning: boolean
	stop(): Promise<void>
}



export class WorkerRunner {

	public register(name: string) {

	}

	public start(name?: string): { close: () => Promise<void> } {
		return {
			close: async () => {

			},
		}
	}
}
