import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { Errors } from '../errors.js';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Validates and coerces body/query/params with zod. Parsed values replace the raw ones,
 * so controllers can trust (and cast) what they read.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const issues: { location: string; path: string; message: string }[] = [];

    for (const location of ['params', 'query', 'body'] as const) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(req[location] ?? {});
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({ location, path: issue.path.join('.'), message: issue.message });
        }
        continue;
      }
      // Express 5 exposes req.query as a getter, so redefine instead of assigning.
      Object.defineProperty(req, location, {
        value: result.data,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    if (issues.length) return next(Errors.validation(issues));
    next();
  };
}
