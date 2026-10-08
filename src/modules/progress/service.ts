import { progressRepository } from './repository.js';

export const progressService = {
  async getProgress(userId: string) {
    const [skills, reports] = await Promise.all([
      progressRepository.trends(userId),
      progressRepository.reportTrends(userId),
    ]);
    return { skills, dimensions: reports.dimensions, overall: reports.overall };
  },

  latestSkillScores(userId: string): Promise<Record<string, number>> {
    return progressRepository.latestScores(userId);
  },
};
