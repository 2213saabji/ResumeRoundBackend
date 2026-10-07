import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

/** One document per signed-in device. Replaces a Redis session store; TTL removes expired sessions. */
const refreshSessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    userAgent: { type: String, maxlength: 512 },
    ip: { type: String },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date },
  },
  { timestamps: true, collection: 'refresh_sessions' },
);

refreshSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshSessionSchema.index({ userId: 1 });

export type RefreshSession = InferSchemaType<typeof refreshSessionSchema> & { _id: Types.ObjectId };
export const RefreshSessionModel = model('RefreshSession', refreshSessionSchema);
