import type { DevelopersRepository } from '../repositories/developers.repository.js';
import type { DeveloperActionRecord, DeveloperActionType } from '../types/developers.types.js';
import type { UpsertActionDto } from '../dto/developers.dto.js';

export class ActionsService {
  constructor(private readonly repo: DevelopersRepository) {}

  async listActions(workspaceId: string): Promise<DeveloperActionRecord[]> {
    const rows = await this.repo.listActions(workspaceId);
    return rows.map((r) => this.serialize(r));
  }

  async upsertAction(workspaceId: string, dto: UpsertActionDto): Promise<DeveloperActionRecord> {
    const row = await this.repo.upsertAction(workspaceId, dto.actionType, {
      name: dto.name,
      method: dto.method,
      url: dto.url,
      headers: dto.headers,
      timeoutMs: dto.timeoutMs,
      enabled: dto.enabled,
    });
    return this.serialize(row);
  }

  /** Used by AI Agent / Journey Engine to execute configured actions. */
  async getEnabledAction(workspaceId: string, actionType: DeveloperActionType) {
    const rows = await this.repo.listActions(workspaceId);
    const action = rows.find((a) => a.actionType === actionType && a.enabled);
    if (!action?.url) return null;
    return {
      actionType: action.actionType as DeveloperActionType,
      method: action.method,
      url: action.url,
      headers: (action.headers ?? {}) as Record<string, string>,
      timeoutMs: action.timeoutMs,
    };
  }

  private serialize(row: {
    id: string;
    actionType: string;
    name: string;
    method: string;
    url: string;
    headers: unknown;
    timeoutMs: number;
    enabled: boolean;
    updatedAt: Date;
  }): DeveloperActionRecord {
    return {
      id: row.id,
      actionType: row.actionType as DeveloperActionType,
      name: row.name,
      method: row.method,
      url: row.url,
      headers: (row.headers ?? {}) as Record<string, string>,
      timeoutMs: row.timeoutMs,
      enabled: row.enabled,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
