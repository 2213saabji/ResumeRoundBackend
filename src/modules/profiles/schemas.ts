import { z } from 'zod';
import { LEVELS } from '../../common/domain.js';

const tag = z.string().trim().min(1).max(60);
const tags = z.array(tag).max(50);

/** Arrays are replaced wholesale: the client sends the full corrected list. */
export const updateProfileSchema = z
  .object({
    experienceYears: z.number().min(0).max(50),
    seniority: z.enum(LEVELS),
    domain: z.string().trim().max(100).nullable(),
    skills: z
      .object({
        languages: tags,
        frameworks: tags,
        databases: tags,
        cloud: tags,
        architecture: tags,
      })
      .strict(),
    projects: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            technologies: tags,
            description: z.string().trim().max(2000),
            scaleSignals: z.array(z.string().trim().min(1).max(200)).max(20),
          })
          .strict(),
      )
      .max(15),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
