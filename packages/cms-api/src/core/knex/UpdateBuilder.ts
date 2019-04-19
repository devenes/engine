import QueryBuilder from './QueryBuilder'
import KnexWrapper from './KnexWrapper'
import Returning from './internal/Returning'
import With from './internal/With'
import Where from './internal/Where'
import SelectBuilder from './SelectBuilder'
import Literal from './Literal'
import Compiler from './Compiler'
import { QueryResult } from 'pg'

class UpdateBuilder<Result extends UpdateBuilder.UpdateResult, Filled extends keyof UpdateBuilder<Result, never>>
	implements With.Aware, Where.Aware, QueryBuilder {
	private constructor(private readonly wrapper: KnexWrapper, private readonly options: UpdateBuilder.Options) {}

	public static create(wrapper: KnexWrapper): UpdateBuilder.NewUpdateBuilder {
		return new UpdateBuilder(wrapper, {
			table: undefined,
			with: new With.Statement(wrapper, {}),
			values: undefined,
			returning: new Returning(),
			from: undefined,
			where: new Where.Statement(wrapper, []),
		}) as UpdateBuilder.UpdateBuilderState<UpdateBuilder.AffectedRows, never>
	}

	public with(alias: string, expression: With.Expression): UpdateBuilder.UpdateBuilderState<Result, Filled | 'with'> {
		return this.withOption('with', this.options.with.withCte(alias, expression))
	}

	public table(name: string): UpdateBuilder.UpdateBuilderState<Result, Filled | 'table'> {
		return this.withOption('table', name)
	}

	public values(columns: QueryBuilder.Values): UpdateBuilder.UpdateBuilderState<Result, Filled | 'values'> {
		return this.withOption('values', QueryBuilder.resolveValues(columns, this.wrapper))
	}

	public returning(
		column: string | Literal
	): UpdateBuilder.UpdateBuilderState<Returning.Result[], Filled | 'returning'> {
		return this.withOption('returning', new Returning(column)) as UpdateBuilder.UpdateBuilderState<
			Returning.Result[],
			Filled | 'returning'
		>
	}

	public from(from: SelectBuilder.Callback): UpdateBuilder.UpdateBuilderState<Result, Filled | 'from'> {
		return this.withOption('from', from)
	}

	public where(where: Where.Expression): UpdateBuilder.UpdateBuilderState<Result, Filled | 'where'> {
		return this.withOption('where', this.options.where.withWhere(where))
	}

	public createQuery(): Literal {
		const values = this.options.values
		const table = this.options.table

		if (table === undefined || values === undefined) {
			throw Error()
		}

		let from: Literal | undefined
		let where = this.options.where

		const cteAliases = this.options.with.getAliases()
		if (this.options.from !== undefined) {
			let fromQb: SelectBuilder = SelectBuilder.create(this.wrapper).withCteAliases(cteAliases)
			fromQb = this.options.from(fromQb)
			fromQb = this.options.where.values.reduce((builder, value) => builder.where(value), fromQb)
			const selectSql = fromQb.createQuery()
			if (!selectSql.sql.startsWith('select *')) {
				throw new Error(`Query does not start with "select *": ${selectSql.sql}`)
			}
			from = new Literal(selectSql.sql.substring('select *'.length), selectSql.parameters)
			where = new Where.Statement(this.wrapper, [])
		}

		const compiler = new Compiler()
		const namespaceContext = new Compiler.NamespaceContext(this.wrapper.schema, new Set(cteAliases))
		return compiler.compileUpdate({ ...this.options, values, table, from, where }, namespaceContext)
	}

	public async execute(): Promise<Result> {
		const query = this.createQuery()
		const result: QueryResult = await this.wrapper.raw(query.sql, ...query.parameters)
		return this.options.returning.parseResponse<Result>(result)
	}

	protected withOption<K extends keyof UpdateBuilder.Options, V extends UpdateBuilder.Options[K]>(
		key: K,
		value: V
	): UpdateBuilder.UpdateBuilderState<Result, Filled | K> {
		return new UpdateBuilder<Result, Filled | K>(this.wrapper, {
			...this.options,
			[key]: value,
		}) as UpdateBuilder.UpdateBuilderState<Result, Filled | K>
	}
}

namespace UpdateBuilder {
	export type AffectedRows = number
	export type UpdateResult = AffectedRows | Returning.Result[]

	export type Options = {
		table: string | undefined
		values: QueryBuilder.ResolvedValues | undefined
		returning: Returning
		from: SelectBuilder.Callback | undefined
	} & With.Options &
		Where.Options

	export type ResolvedOptions = Pick<Options, Exclude<keyof Options, 'from'>> & {
		from: Literal | undefined
		table: Exclude<Options['table'], undefined>
		values: Exclude<Options['values'], undefined>
	}

	export type UpdateBuilderWithoutExecute<
		Result extends UpdateResult,
		Filled extends keyof UpdateBuilder<Result, Filled>
	> = Pick<UpdateBuilder<Result, Filled>, Exclude<keyof UpdateBuilder<Result, Filled>, 'execute' | 'createQuery'>>

	export type UpdateBuilderState<Result extends UpdateResult, Filled extends keyof UpdateBuilder<Result, Filled>> =
		| 'table'
		| 'values' extends Filled
		? UpdateBuilder<Result, Filled>
		: UpdateBuilderWithoutExecute<Result, Filled>

	export type NewUpdateBuilder = UpdateBuilder.UpdateBuilderState<UpdateBuilder.AffectedRows, never>
}

export default UpdateBuilder
