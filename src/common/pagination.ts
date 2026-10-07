import { z } from 'zod';

export const cursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
