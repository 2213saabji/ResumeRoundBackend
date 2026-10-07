import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const VALID_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Accepts a sane upstream X-Request-Id (load balancer) or mints one; echoed on the response. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};
