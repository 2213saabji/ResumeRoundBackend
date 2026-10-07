import { NonRetryableError } from '../jobs/queue.js';
import type { JobHandler } from '../jobs/worker.js';
import { ReportModel, type Report } from './model.js';

export function toPublicReport(r: Report) {
  return {
    id: r._id.toString(),
    interviewId: r.interviewId.toString(),
    dimensionScores: r.dimensionScores as Record<string, number>,
    overall: r.overall,
    strengths: r.strengths,
    weaknesses: r.weaknesses,
    feedback: r.feedback,
    recommendations: r.recommendations,
    createdAt: r.createdAt,
  };
}

export const reportsService = {
  async findForInterview(interviewId: string) {
    const report = await ReportModel.findOne({ interviewId }).lean<Report>();
    return report ? toPublicReport(report) : null;
  },
};

/** MVP-3: aggregate turn evaluations + generateReport (large model) + write skill_history. */
export const generateReportJob: JobHandler<'report.generate'> = async (payload) => {
  throw new NonRetryableError(
    `Report generation is not implemented yet (interview ${payload.interviewId})`,
  );
};
