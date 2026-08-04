import type { InstagramJourneyRepository } from '../repositories/ig-journey.repository.js';
import type { InstagramJourneyGraphService } from './ig-journey-graph.service.js';
import type { CreateIgJourneyDto, UpdateIgJourneyDto } from '../dto/ig-journey.dto.js';
import { normalizeIgTriggerEvents } from '../types/ig-journey.types.js';

export class InstagramJourneyService {
  constructor(
    private readonly journeyRepo: InstagramJourneyRepository,
    private readonly graphService: InstagramJourneyGraphService
  ) {}

  list(workspaceId: string) {
    return this.journeyRepo.listByWorkspace(workspaceId).then((rows) =>
      rows.map(({ nodes, ...journey }) => {
        const data = (nodes[0]?.data ?? {}) as Record<string, unknown>;
        const events = normalizeIgTriggerEvents(data);
        // Single → event string; multi → joined (list UI parses).
        const triggerEvent = events.length === 0 ? null : events.join(',');
        return { ...journey, triggerEvent };
      })
    );
  }

  get(workspaceId: string, id: string) {
    return this.journeyRepo.findById(workspaceId, id);
  }

  create(workspaceId: string, dto: CreateIgJourneyDto) {
    return this.journeyRepo.create(workspaceId, dto.name);
  }

  async update(workspaceId: string, id: string, dto: UpdateIgJourneyDto) {
    await this.journeyRepo.update(workspaceId, id, dto);
    return this.journeyRepo.findById(workspaceId, id);
  }

  delete(workspaceId: string, id: string) {
    return this.journeyRepo.delete(workspaceId, id);
  }

  async publish(workspaceId: string, id: string) {
    const errors = await this.graphService.validateForPublish(workspaceId, id);
    if (errors.length) throw new Error(errors.join('; '));
    await this.journeyRepo.update(workspaceId, id, { status: 'published' });
    return this.journeyRepo.findById(workspaceId, id);
  }
}
