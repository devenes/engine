import { PromiseMap } from '@contember/engine-common'
import { ProjectContainer } from './ProjectContainer'

type ContainerWithMeta = { container: ProjectContainer; cleanups: (() => void)[]; timestamp: Date }

export class ProjectContainerStore {
	private containers = new PromiseMap<string, ContainerWithMeta>()
	private resolvedContainers = new Map<string, ContainerWithMeta>()
	private aliasMapping = new Map<string, string>()

	public resolveAlias(slug: string): string | undefined {
		return this.aliasMapping.get(slug)
	}

	public setAlias(slug: string, alias: string): void {
		this.aliasMapping.set(alias, slug)
	}

	public removeAlias(alias: string): void {
		this.aliasMapping.delete(alias)
	}

	public getContainer(slug: string): Promise<ContainerWithMeta> | undefined {
		return this.containers.get(slug)
	}

	public async fetchContainer(slug: string, factory: (slug: string) => Promise<ContainerWithMeta>): Promise<ContainerWithMeta> {
		const container = await this.containers.fetch(slug, factory)

		// removed during await
		if (this.containers.has(slug)) {
			this.resolvedContainers.set(slug, container)
		}
		return container
	}

	public removeContainer(slug: string): void {
		this.containers.delete(slug)
		this.resolvedContainers.delete(slug)
	}

	public getAllResolved(): ContainerWithMeta[] {
		return Array.from(this.resolvedContainers.values())
	}
}
