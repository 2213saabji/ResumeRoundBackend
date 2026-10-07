import { Types } from 'mongoose';
import { SkillHistoryModel } from './model.js';

export interface SkillTrend {
  skill: string;
  latest: number;
  points: { score: number; at: Date; interviewId: string }[];
}

export const progressRepository = {
  /** Latest score per skill, keyed by lower-cased skill name. */
  async latestScores(userId: string): Promise<Record<string, number>> {
    const rows = await SkillHistoryModel.aggregate<{ _id: string; score: number }>([
      { $match: { userId: new Types.ObjectId(userId) } },
      { $sort: { skill: 1, at: -1 } },
      { $group: { _id: '$skill', score: { $first: '$score' } } },
    ]);
    return Object.fromEntries(rows.map((r) => [r._id, r.score]));
  },

  async trends(userId: string, pointsPerSkill = 20): Promise<SkillTrend[]> {
    const rows = await SkillHistoryModel.aggregate<{
      _id: string;
      points: { score: number; at: Date; interviewId: Types.ObjectId }[];
    }>([
      { $match: { userId: new Types.ObjectId(userId) } },
      { $sort: { skill: 1, at: -1 } },
      {
        $group: {
          _id: '$skill',
          points: { $push: { score: '$score', at: '$at', interviewId: '$interviewId' } },
        },
      },
      { $project: { points: { $slice: ['$points', pointsPerSkill] } } },
      { $sort: { _id: 1 } },
    ]);
    return rows.map((r) => ({
      skill: r._id,
      latest: r.points[0]?.score ?? 0,
      // Oldest first, ready for a trend chart.
      points: r.points
        .map((p) => ({ score: p.score, at: p.at, interviewId: p.interviewId.toString() }))
        .reverse(),
    }));
  },
};
