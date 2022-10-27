import { ProjectGroupContainer } from '@contember/engine-http'

export class DispatchWorkerManager {
	constructor(

	) {
	}

	public async run(projectGroup: ProjectGroupContainer) {
		const tenantContainer = projectGroup.tenantContainer
		const projects = tenantContainer.projectManager.getProjects(tenantContainer.databaseContext)

	}
}
