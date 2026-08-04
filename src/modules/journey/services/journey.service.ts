import type { JourneyRepository } from '../repositories/journey.repository.js';
import type { JourneyGraphService } from './journey-graph.service.js';
import type { CreateJourneyDto, UpdateJourneyDto } from '../dto/journey.dto.js';

export class JourneyService {
  constructor(
    private readonly journeyRepo: JourneyRepository,
    private readonly graphService: JourneyGraphService
  ) {}

  list(workspaceId: string) {
    return this.journeyRepo.listByWorkspace(workspaceId).then((rows) =>
      rows.map(({ nodes, ...journey }) => {
        const data = (nodes[0]?.data ?? {}) as Record<string, unknown>;
        const triggerEvent =
          typeof data.event === 'string' && data.event ? data.event : null;
        return { ...journey, triggerEvent };
      })
    );
  }

  get(workspaceId: string, id: string) {
    return this.journeyRepo.findById(workspaceId, id);
  }

  create(workspaceId: string, dto: CreateJourneyDto) {
    return this.journeyRepo.create(workspaceId, dto.name);
  }

  async update(workspaceId: string, id: string, dto: UpdateJourneyDto) {
    await this.journeyRepo.update(workspaceId, id, dto);
    return this.journeyRepo.findById(workspaceId, id);
  }

  delete(workspaceId: string, id: string) {
    return this.journeyRepo.delete(workspaceId, id);
  }

  async publish(workspaceId: string, id: string) {
    const errors = await this.graphService.validateForPublish(workspaceId, id);
    if (errors.length) {
      throw new Error(errors.join('; '));
    }
    await this.journeyRepo.update(workspaceId, id, { status: 'published' });
    return this.journeyRepo.findById(workspaceId, id);
  }
}
