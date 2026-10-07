import { progressRepository } from './repository.js';

export const progressService = {
  async getProgress(userId: string) {
    return { skills: await progressRepository.trends(userId) };
  },

  latestSkillScores(userId: string): Promise<Record<string, number>> {
    return progressRepository.latestScores(userId);
  },
};
