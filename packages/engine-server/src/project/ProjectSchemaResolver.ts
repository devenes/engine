import {
	DatabaseContext,
	ProjectGroup,
	ProjectSchemaResolver as ProjectSchemaResolverInterface,
} from '@contember/engine-tenant-api'
import { SchemaVersionBuilder, VersionedSchema } from '@contember/engine-system-api'
import { ProjectContainerResolver } from '@contember/engine-http'
import { Schema } from '@contember/schema'

export class ProjectSchemaResolver implements ProjectSchemaResolverInterface {
	private schemaCache = new Map<string, VersionedSchema>()

	constructor(
		private readonly projectContainerResolver: ProjectContainerResolver,
		private readonly schemaVersionBuilder: SchemaVersionBuilder,
	) {}

	async getSchema(projectGroup: ProjectGroup, slug: string) {
		const container = await this.projectContainerResolver.getProjectContainer(projectGroup, slug)
		if (!container) {
			return undefined
		}
		const cacheKey = JSON.stringify({ groupSlug: projectGroup.slug, slug })
		const db = container.systemDatabaseContextFactory.create(undefined)
		const cachedSchema = this.schemaCache.get(cacheKey)
		const newSchema = await this.schemaVersionBuilder.buildSchema(db, cachedSchema)
		if (cachedSchema !== newSchema) {
			this.schemaCache.set(cacheKey, newSchema)
		}
		return newSchema
	}

	clearCache() {
		this.schemaCache.clear()
	}
}

export class ProjectSchemaResolverProxy implements ProjectSchemaResolverInterface {
	private resolver: ProjectSchemaResolver | undefined

	setResolver(resolver: ProjectSchemaResolver): void {
		this.resolver = resolver
	}

	getSchema(projectGroup: ProjectGroup, projectSlug: string): Promise<Schema | undefined> {
		if (!this.resolver) {
			throw new Error('Resolved is not set')
		}
		return this.resolver.getSchema(projectGroup, projectSlug)
	}

	clearCache() {
		this.resolver?.clearCache()
	}
}
