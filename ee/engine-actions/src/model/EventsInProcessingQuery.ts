import { DatabaseQuery, DatabaseQueryable, SelectBuilder } from '@contember/database'
import { EventRow } from './types'
import { EventArgs } from '../graphql/schema'

export class EventsInProcessingQuery extends DatabaseQuery<EventRow[]> {
	constructor(
		private readonly args: EventArgs,
	) {
		super()
	}

	async fetch(queryable: DatabaseQueryable): Promise<EventRow[]> {
		return SelectBuilder.create<EventRow>()
			.from('actions_event')
			.select('*')
			.where(it => it.in('state', ['processing']))
			.orderBy('last_state_change', 'asc')
			.limit(this.args.limit ?? 100, this.args.offset ?? 0)
			.getResult(queryable.db)
	}
}
