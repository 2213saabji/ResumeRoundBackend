import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { LEVELS } from '../../common/domain.js';

export const QUESTION_CATEGORIES = [
  'fundamentals',
  'project',
  'system_design',
  'scaling',
  'debugging',
  'behavioral',
  'coding',
] as const;

const questionSchema = new Schema(
  {
    text: { type: String, required: true },
    category: { type: String, enum: QUESTION_CATEGORIES, required: true },
    technologies: { type: [String], default: [] },
    difficulty: { type: Number, min: 1, max: 10, required: true },
    seniority: { type: [String], enum: LEVELS, default: [] },
    expectedConcepts: { type: [String], default: [] },
    rubricId: { type: Schema.Types.ObjectId, ref: 'Rubric' },
    followUps: { type: [String], default: [] },
    // Scenario questions reveal information stage by stage (e.g. p95 = 1.4s, then DB CPU 85%).
    scenario: {
      stages: [
        { _id: false, reveal: { type: String, required: true }, expectedConcepts: [String] },
      ],
    },
    source: {
      type: { type: String, enum: ['curated', 'public_report'], default: 'curated' },
      url: String,
      reportedAt: Date,
    },
    // Filled by the embed job; indexed by Atlas Vector Search (see docs/atlas-vector-search.md).
    embedding: { type: [Number], select: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'questions' },
);
questionSchema.index({ category: 1, difficulty: 1 });

export type Question = InferSchemaType<typeof questionSchema> & { _id: Types.ObjectId };
export const QuestionModel = model('Question', questionSchema);

const rubricSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    category: { type: String, enum: QUESTION_CATEGORIES, required: true },
    dimensions: [
      {
        _id: false,
        key: { type: String, required: true },
        weight: { type: Number, min: 0, max: 1, required: true },
        criteria: { type: String, required: true },
      },
    ],
  },
  { timestamps: true, collection: 'rubrics' },
);

export type Rubric = InferSchemaType<typeof rubricSchema> & { _id: Types.ObjectId };
export const RubricModel = model('Rubric', rubricSchema);
