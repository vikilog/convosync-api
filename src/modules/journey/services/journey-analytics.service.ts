import type { JourneyExecutionRepository } from '../repositories/journey-execution.repository.js';

export class JourneyAnalyticsService {
  constructor(private readonly executionRepo: JourneyExecutionRepository) {}

  async getJourneyAnalytics(journeyId: string) {
    const logs = await this.executionRepo.getAnalytics(journeyId);
    const counts: Record<string, number> = {
      sent: 0,
      delivered: 0,
      read: 0,
      clicked: 0,
      replied: 0,
    };

    for (const log of logs) {
      const payload = log.payload as { metric?: string } | null;
      const metric = payload?.metric;
      if (metric && metric in counts) {
        counts[metric] += 1;
      }
    }

    const executions = await this.executionRepo.countExecutionsByStatus(journeyId);
    const executionSummary = Object.fromEntries(
      executions.map((row) => [row.status, row._count._all])
    );

    return { metrics: counts, executions: executionSummary };
  }
}
