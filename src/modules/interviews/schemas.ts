import { z } from 'zod';
import { COMPANY_TYPES, LEVELS, TARGET_ROLES } from '../../common/domain.js';
import { cursorQuerySchema } from '../../common/pagination.js';

/** Omitted fields fall back to the user's onboarding preferences. */
export const createInterviewSchema = z
  .object({
    role: z.enum(TARGET_ROLES).optional(),
    level: z.enum(LEVELS).optional(),
    companyType: z.enum(COMPANY_TYPES).optional(),
    durationMin: z.union([z.literal(15), z.literal(30), z.literal(45)]).default(30),
    mode: z.enum(['voice', 'text']).default('voice'),
  })
  .strict();

export const listTurnsQuerySchema = cursorQuerySchema;

export type CreateInterviewInput = z.infer<typeof createInterviewSchema>;
