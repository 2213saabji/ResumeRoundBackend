import { config } from '../../common/config.js';
import { withTransaction } from '../../common/db.js';
import { getAiGateway } from '../ai/gateway.js';
import { AiError } from '../ai/types.js';
import { aiContext, planOf } from '../interviews/ai-context.js';
import type { Interview } from '../interviews/model.js';
import { interviewsRepository } from '../interviews/repository.js';
import { jobQueue, NonRetryableError } from '../jobs/queue.js';
import type { JobContext, JobHandler } from '../jobs/worker.js';
import { progressRepository } from '../progress/repository.js';
import { aggregateScores, MIN_ANSWERS_FOR_REPORT } from './aggregate.js';
import { ReportModel, type Report } from './model.js';

export function toPublicReport(r: Report) {
  return {
    id: r._id.toString(),
    interviewId: r.interviewId.toString(),
    overall: r.overall,
    dimensionScores: r.dimensionScores as Record<string, number>,
    questionsAnswered: r.questionsAnswered ?? 0,
    strengths: r.strengths,
    weaknesses: r.weaknesses,
    feedback: r.feedback,
    recommendations: r.recommendations.map((rec) => ({
      topic: rec.topic,
      reason: rec.reason ?? '',
      resources: rec.resources.map((res) => ({ title: res.title ?? '', url: res.url ?? null })),
    })),
    createdAt: r.createdAt,
  };
}

export type ReportState =
  | { status: 'ready'; report: ReturnType<typeof toPublicReport> }
  | { status: 'generating' }
  | { status: 'insufficient_answers' | 'failed'; message: string };

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export const reportsService = {
  async findForInterview(interviewId: string) {
    const report = await ReportModel.findOne({ interviewId }).lean<Report>();
    return report ? toPublicReport(report) : null;
  },

  /** What GET /interviews/:id/report shows for an ended interview. */
  async getState(interview: Interview): Promise<ReportState> {
    const id = interview._id.toString();
    const report = await this.findForInterview(id);
    if (report) return { status: 'ready', report };

    switch (interview.reportStatus) {
      case 'insufficient_answers':
        return {
          status: 'insufficient_answers',
          message: `Answer at least ${MIN_ANSWERS_FOR_REPORT} questions to get a report.`,
        };
      case 'failed':
        return {
          status: 'failed',
          message: 'We could not generate your report. Please try again later.',
        };
      case undefined:
        // Ended before reports existed: queue its report once, on first view.
        await withTransaction(async (session) => {
          if (await interviewsRepository.claimLegacyReport(id, session)) {
            await jobQueue.enqueue('report.generate', { interviewId: id }, { session });
          }
        });
        return { status: 'generating' };
      default:
        return { status: 'generating' };
    }
  },

  /**
   * Job body for `report.generate`. Scores are aggregated in code; the AI writes the
   * narrative. The report, skill history and status commit together. Idempotent.
   */
  async generate(interviewId: string, ctx: Pick<JobContext, 'isFinalAttempt' | 'log'>) {
    const interview = await interviewsRepository.findById(interviewId);
    if (!interview) throw new NonRetryableError(`Interview ${interviewId} not found`);
    if (interview.status !== 'ended') {
      throw new NonRetryableError(`Interview ${interviewId} has not ended`);
    }
    if (await ReportModel.exists({ interviewId })) {
      await interviewsRepository.setReportStatus(interviewId, 'ready');
      return;
    }

    const turns = await interviewsRepository.evaluatedTurns(interviewId);
    if (turns.length < MIN_ANSWERS_FOR_REPORT) {
      await interviewsRepository.setReportStatus(interviewId, 'insufficient_answers');
      ctx.log.info({ interviewId, answers: turns.length }, 'too few answers for a report');
      return;
    }

    const plan = planOf(interview);
    const scores = aggregateScores(
      turns.map((t) => ({
        dimensionScores: (t.evaluation?.dimensionScores ?? {}) as Record<string, number>,
        overall: t.evaluation?.overall ?? 0,
        confidence: t.evaluation?.confidence ?? 1,
        technologies: plan[t.objectiveIdx]?.technologies ?? [],
      })),
    );

    try {
      const gateway = getAiGateway();
      const narrative = await gateway.generateReport(
        {
          context: await aiContext(interview),
          endReason: interview.endReason ?? 'completed',
          dimensionScores: scores.dimensionScores,
          overall: scores.overall,
          turns: turns.map((t) => ({
            objectiveKind: t.objectiveKind ?? plan[t.objectiveIdx]?.kind ?? 'unknown',
            topic: plan[t.objectiveIdx]?.topic ?? '',
            question: t.questionText,
            answer: t.answerText ?? '',
            overall: t.evaluation?.overall ?? 0,
            missedConcepts: t.evaluation?.missedConcepts ?? [],
            evidence: (t.evaluation?.evidence ?? []).map((e) => ({
              dimension: e.dimension ?? '',
              quote: e.quote ?? '',
              note: e.note ?? '',
            })),
          })),
        },
        { userId: interview.userId.toString(), interviewId },
      );

      await withTransaction(async (session) => {
        await ReportModel.create(
          [
            {
              interviewId,
              userId: interview.userId,
              overall: scores.overall,
              dimensionScores: scores.dimensionScores,
              questionsAnswered: turns.length,
              strengths: narrative.strengths,
              weaknesses: narrative.weaknesses,
              feedback: narrative.feedback,
              recommendations: narrative.recommendations.map((rec) => ({
                topic: rec.topic,
                reason: rec.reason,
                resources: rec.resources.map((title) => ({ title })),
              })),
              generatedBy: {
                provider: gateway.provider,
                model: gateway.provider === 'anthropic' ? config.AI_MODEL_LARGE : gateway.provider,
              },
            },
          ],
          { session },
        );
        await progressRepository.recordInterview(
          interview.userId.toString(),
          interviewId,
          scores.skillScores,
          interview.endedAt ?? new Date(),
          session,
        );
        await interviewsRepository.setReportStatus(interviewId, 'ready', session);
      });
      ctx.log.info({ interviewId, overall: scores.overall }, 'report generated');
    } catch (err) {
      // A concurrent run already stored the report.
      if (isDuplicateKey(err)) return;
      const permanent = err instanceof AiError && !err.retryable;
      if (permanent || ctx.isFinalAttempt) {
        await interviewsRepository.setReportStatus(interviewId, 'failed');
      }
      if (permanent) throw new NonRetryableError(err.message);
      throw err;
    }
  },
};

export const generateReportJob: JobHandler<'report.generate'> = (payload, ctx) =>
  reportsService.generate(payload.interviewId, ctx);
