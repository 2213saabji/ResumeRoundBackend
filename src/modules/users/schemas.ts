import { z } from 'zod';
import { COMPANY_TYPES, LEVELS, TARGET_ROLES } from '../../common/domain.js';

export const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    targetRole: z.enum(TARGET_ROLES),
    level: z.enum(LEVELS),
    companyType: z.enum(COMPANY_TYPES),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export type UpdateMeInput = z.infer<typeof updateMeSchema>;
