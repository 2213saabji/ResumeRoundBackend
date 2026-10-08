import { Types, type ClientSession } from 'mongoose';
import { ReportModel } from '../reports/model.js';
import { SkillHistoryModel } from './model.js';

export interface SkillTrend {
  skill: string;
  latest: number;
  points: { score: number; at: Date; interviewId: string }[];
}

export interface ScorePoint {
  score: number;
  at: Date;
  interviewId: string;
}

export interface DimensionTrend {
  dimension: string;
  latest: number;
  points: ScorePoint[];
}

export const progressRepository = {
  /** One skill_history row per skill scored in an interview. Run in the report transaction. */
  async recordInterview(
    userId: string,
    interviewId: string,
    skillScores: Record<string, number>,
    at: Date,
    session: ClientSession,
  ): Promise<void> {
    const rows = Object.entries(skillScores).map(([skill, score]) => ({
      userId,
      interviewId,
      skill,
      score,
      at,
    }));
    if (rows.length) await SkillHistoryModel.insertMany(rows, { session });
  },

  /** Overall and per-dimension score trends from the user's reports, oldest first. */
  async reportTrends(
    userId: string,
    limit = 20,
  ): Promise<{ overall: ScorePoint[]; dimensions: DimensionTrend[] }> {
    const reports = await ReportModel.find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select({ interviewId: 1, overall: 1, dimensionScores: 1, createdAt: 1 })
      .lean();
    reports.reverse();

    const byDimension = new Map<string, ScorePoint[]>();
    const overall: ScorePoint[] = [];
    for (const r of reports) {
      const base = { at: r.createdAt, interviewId: r.interviewId.toString() };
      overall.push({ score: r.overall, ...base });
      for (const [dimension, score] of Object.entries(
        (r.dimensionScores ?? {}) as Record<string, number>,
      )) {
        if (!byDimension.has(dimension)) byDimension.set(dimension, []);
        byDimension.get(dimension)!.push({ score, ...base });
      }
    }
    return {
      overall,
      dimensions: [...byDimension.entries()].map(([dimension, points]) => ({
        dimension,
        latest: points.at(-1)!.score,
        points,
      })),
    };
  },

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
