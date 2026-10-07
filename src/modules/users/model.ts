import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { COMPANY_TYPES, LEVELS, TARGET_ROLES } from '../../common/domain.js';

export const USER_ROLES = ['candidate', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, select: false },
    authProvider: { type: String, enum: ['password', 'google'], required: true },
    googleId: { type: String },
    name: { type: String, trim: true, maxlength: 120 },
    role: { type: String, enum: USER_ROLES, default: 'candidate', required: true },
    targetRole: { type: String, enum: TARGET_ROLES },
    level: { type: String, enum: LEVELS },
    companyType: { type: String, enum: COMPANY_TYPES },
    onboardedAt: { type: Date },
  },
  { timestamps: true, collection: 'users' },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index(
  { googleId: 1 },
  { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } },
);

export type User = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export const UserModel = model('User', userSchema);
