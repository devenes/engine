import { PathFactory } from './Path'
import { WhereBuilder } from './WhereBuilder'
import { Client, LimitByGroupWrapper, Operator, SelectBuilder } from '@contember/database'
import { Input, Model, Value } from '@contember/schema'
import { OrderByBuilder } from './OrderByBuilder'
import { PredicatesInjector } from '../../acl'
import { FieldNode, ObjectNode } from '../../inputProcessing'
import { JoiningColumns } from '../types'
import { OrderByHelper } from './OrderByHelper'
import { SelectGroupedObjects, SelectResultObject, SelectRow } from './SelectHydrator'
import { Mapper } from '../Mapper'

export type GroupedCounts = Record<Input.PrimaryValue, number>

type CountOneHasManyGroupsArgs = {
	mapper: Mapper
	filter: Input.OptionalWhere | undefined
	relationPath: Model.AnyRelationContext[]
	relationContext: Model.OneHasManyContext
	ids: Input.PrimaryValue[]
}

type FetchOneHasManyGroupsArgs = {
	mapper: Mapper
	objectNode: ObjectNode<Input.ListQueryInput>
	relationPath: Model.AnyRelationContext[]
	relationContext: Model.OneHasManyContext
	ids: Input.PrimaryValue[]
}

type ManyHasManyBaseArgs =
	& {
		mapper: Mapper
		ids: Input.PrimaryValue[]
		relationPath: Model.AnyRelationContext[]
		relationContext: Model.ManyHasManyInverseContext | Model.ManyHasManyOwningContext
	}
type CountManyHasManyGroupArgs =
	& ManyHasManyBaseArgs
	& {
		filter: Input.OptionalWhere | undefined
	}

type FetchManyHasManyGroupsArgs =
	& ManyHasManyBaseArgs
	& {
		field: ObjectNode<Input.ListQueryInput>
	}

export class RelationFetcher {
	constructor(
		private readonly whereBuilder: WhereBuilder,
		private readonly orderBuilder: OrderByBuilder,
		private readonly predicateInjector: PredicatesInjector,
		private readonly pathFactory: PathFactory,
	) {}

	public async countOneHasManyGroups({
		mapper,
		filter,
		relationContext,
		relationPath,
		ids,
	}: CountOneHasManyGroupsArgs): Promise<GroupedCounts> {
		const { targetRelation, targetEntity } = relationContext
		const filterWithParent = this.createOneHasManyFilter(targetEntity, targetRelation, ids, filter)
		return mapper.countGrouped(targetEntity, filterWithParent, targetRelation, [
			...relationPath,
			relationContext,
		])
	}

	public async fetchOneHasManyGroups({
		mapper,
		objectNode,
		relationContext,
		relationPath,
		ids,
	}: FetchOneHasManyGroupsArgs): Promise<SelectGroupedObjects> {
		const { relation, targetEntity, targetRelation } = relationContext
		const filter = this.createOneHasManyFilter(targetEntity, targetRelation, ids, objectNode.args.filter)
		const objectNodeWithWhere = objectNode.withArg<Input.ListQueryInput>('filter', filter)
		const objectNodeWithOrder = OrderByHelper.appendDefaultOrderBy(
			targetEntity,
			objectNodeWithWhere,
			relation.orderBy || [],
		)

		return mapper.selectGrouped(targetEntity, objectNodeWithOrder, targetRelation, [
			...relationPath,
			relationContext,
		])
	}

	private createOneHasManyFilter(
		targetEntity: Model.Entity,
		targetRelation: Model.ManyHasOneRelation,
		ids: Input.PrimaryValue[],
		filter: Input.OptionalWhere | undefined,
	): Input.OptionalWhere {
		const targetRelationFilter: Input.OptionalWhere = { [targetEntity.primary]: { in: ids } }
		return {
			...filter,
			[targetRelation.name]: !filter?.[targetRelation.name]
				? targetRelationFilter
				: ({ and: [filter[targetRelation.name], targetRelationFilter] } as Input.OptionalWhere),
		}
	}

	public async countManyHasManyGroups({
		mapper,
		filter,
		relationContext,
		relationPath,
		ids,
	}: CountManyHasManyGroupArgs): Promise<GroupedCounts> {
		const owningRelation = relationContext.type === 'manyHasManyInverse' ? relationContext.targetRelation : relationContext.relation

		const joiningColumns = this.resolveJoiningColumns({ relationType: relationContext.type, joiningTable: owningRelation.joiningTable })

		const qb = this.buildJunctionQb(owningRelation, ids, joiningColumns, relationContext.targetEntity, { filter }, relationPath)
			.select(['junction_', joiningColumns.sourceColumn.columnName])
			.select(expr => expr.raw('count(*)'), 'row_count')
			.groupBy(['junction_', joiningColumns.sourceColumn.columnName])

		const result = new Map<string, number>()
		const rows = await qb.getResult(mapper.db)
		for (const row of rows) {
			result.set(String(row[joiningColumns.sourceColumn.columnName]), Number(row.row_count))
		}

		return Object.fromEntries(result)
	}

	public async fetchManyHasManyGroups({
		mapper,
		field,
		relationContext,
		relationPath,
		ids,
	}: FetchManyHasManyGroupsArgs): Promise<SelectGroupedObjects> {
		const owningRelation = relationContext.type === 'manyHasManyInverse' ? relationContext.targetRelation : relationContext.relation
		const joiningColumns = this.resolveJoiningColumns({ relationType: relationContext.type, joiningTable: owningRelation.joiningTable })
		const defaultOrderBy = relationContext.relation.orderBy || []
		const objectNode = OrderByHelper.appendDefaultOrderBy(relationContext.targetEntity, field, defaultOrderBy)
		const { targetEntity } = relationContext
		const junctionValues = await this.fetchJunction(
			mapper.db,
			owningRelation,
			ids,
			joiningColumns,
			targetEntity,
			objectNode,
			relationPath,
		)
		if (junctionValues.length === 0) {
			return {}
		}

		const primaryField = new FieldNode(targetEntity.primary, targetEntity.primary, {})
		const inverseJoiningColumn = joiningColumns.targetColumn.columnName
		const inverseIds = junctionValues
			.map(it => it[inverseJoiningColumn])
			.filter((it, index, arr) => arr.indexOf(it) === index)

		const queryWithWhere = objectNode
			.withArgs({
				filter: {
					[targetEntity.primary]: { in: inverseIds },
				},
			})
			.withField(primaryField)
		const result = await mapper.select(targetEntity, queryWithWhere, [...relationPath, relationContext])

		return this.buildManyHasManyGroups(targetEntity, joiningColumns, result, junctionValues)
	}

	private resolveJoiningColumns({ relationType, joiningTable }: { joiningTable: Model.JoiningTable; relationType: 'manyHasManyOwning' | 'manyHasManyInverse' }): JoiningColumns {
		return relationType === 'manyHasManyOwning' ? {
			sourceColumn: joiningTable.joiningColumn,
			targetColumn: joiningTable.inverseJoiningColumn,
		} : {
			sourceColumn: joiningTable.inverseJoiningColumn,
			targetColumn: joiningTable.joiningColumn,
		}
	}

	private buildManyHasManyGroups(
		entity: Model.Entity,
		joiningColumns: JoiningColumns,
		resultObjects: SelectResultObject[],
		junctionValues: SelectRow[],
	): SelectGroupedObjects {
		const dataById: { [id: string]: SelectResultObject } = {}
		for (let object of resultObjects) {
			dataById[object[entity.primary] as Value.PrimaryValue] = object
		}
		const sourceColumn = joiningColumns.sourceColumn.columnName
		const targetColumn = joiningColumns.targetColumn.columnName
		const groupedResult: SelectGroupedObjects = {}
		for (let pair of junctionValues) {
			if (!groupedResult[pair[sourceColumn] as Value.PrimaryValue]) {
				groupedResult[pair[sourceColumn] as Value.PrimaryValue] = []
			}
			const resultObject = dataById[pair[targetColumn] as Value.PrimaryValue]
			if (resultObject) {
				groupedResult[pair[sourceColumn] as Value.PrimaryValue].push(resultObject)
			}
		}
		return groupedResult
	}

	private async fetchJunction(
		db: Client,
		relation: Model.ManyHasManyOwningRelation,
		values: Input.PrimaryValue[],
		column: JoiningColumns,
		targetEntity: Model.Entity,
		object: ObjectNode<Input.ListQueryInput>,
		relationPath: Model.AnyRelationContext[],
	): Promise<Record<string, Value.AtomicValue>[]> {
		const joiningTable = relation.joiningTable
		const qb = this.buildJunctionQb(relation, values, column, targetEntity, object.args, relationPath)
			.select(['junction_', joiningTable.inverseJoiningColumn.columnName])
			.select(['junction_', joiningTable.joiningColumn.columnName])
		const wrapper = new LimitByGroupWrapper(
			['junction_', column.sourceColumn.columnName],
			(orderable, qb) => {
				if (object.args.orderBy) {
					[qb, orderable] = this.orderBuilder.build(
						qb,
						orderable,
						targetEntity,
						this.pathFactory.create([]),
						object.args.orderBy,
					)
				}
				return [orderable, qb]
			},
			object.args.offset,
			object.args.limit,
		)

		return await wrapper.getResult(qb, db)
	}

	private buildJunctionQb(
		relation: Model.ManyHasManyOwningRelation,
		ids: Input.PrimaryValue[],
		column: JoiningColumns,
		targetEntity: Model.Entity,
		objectArgs: Input.ListQueryInput,
		relationPath: Model.AnyRelationContext[],
	): SelectBuilder {
		const joiningTable = relation.joiningTable

		const whereColumn = column.sourceColumn.columnName
		let qb = SelectBuilder.create()
			.from(joiningTable.tableName, 'junction_')
			.where(clause => clause.in(['junction_', whereColumn], ids))

		const where = this.predicateInjector.inject(targetEntity, objectArgs.filter || {})
		const hasWhere = where && Object.keys(where).length > 0
		const hasFieldOrderBy =
			objectArgs.orderBy &&
			objectArgs.orderBy.length > 0 &&
			!objectArgs.orderBy[0]._random &&
			objectArgs.orderBy[0]._randomSeeded === undefined

		if (hasWhere || hasFieldOrderBy) {
			const path = this.pathFactory.create([])
			qb = qb.join(targetEntity.tableName, path.alias, condition =>
				condition.compareColumns(['junction_', column.targetColumn.columnName], Operator.eq, [
					path.alias,
					targetEntity.primaryColumn,
				]),
			)
		}

		if (where && hasWhere) {
			qb = this.whereBuilder.build(qb, targetEntity, this.pathFactory.create([]), where, { relationPath })
		}
		return qb
	}
}
