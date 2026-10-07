import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

const reportSchema = new Schema(
  {
    interviewId: { type: Schema.Types.ObjectId, ref: 'Interview', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    dimensionScores: { type: Schema.Types.Mixed, required: true },
    overall: { type: Number, min: 0, max: 10, required: true },
    strengths: { type: [String], default: [] },
    weaknesses: { type: [String], default: [] },
    feedback: { type: String, default: '' },
    recommendations: [
      {
        _id: false,
        topic: { type: String, required: true },
        reason: { type: String },
        resources: [{ _id: false, title: String, url: String }],
      },
    ],
    generatedBy: { provider: String, model: String },
  },
  { timestamps: true, collection: 'reports' },
);
reportSchema.index({ interviewId: 1 }, { unique: true });
reportSchema.index({ userId: 1, createdAt: -1 });

export type Report = InferSchemaType<typeof reportSchema> & { _id: Types.ObjectId };
export const ReportModel = model('Report', reportSchema);
