import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

export async function registerUser(
  app: App,
  overrides: { email?: string; password?: string } = {},
) {
  const email = overrides.email ?? `user-${randomUUID().slice(0, 8)}@example.com`;
  const password = overrides.password ?? 'correct-horse-battery';
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password, name: 'Test User' });
  if (res.status !== 201)
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    email,
    password,
    userId: res.body.user.id as string,
    accessToken: res.body.accessToken as string,
    cookies: res.headers['set-cookie'] as unknown as string[],
  };
}

/** Builds a minimal valid single-page PDF containing `lines` of text (offsets computed exactly). */
export function makePdf(lines: string[]): Buffer {
  const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = [
    'BT /F1 11 Tf 50 780 Td 14 TL',
    ...lines.map((l) => `(${escape(l)}) Tj T*`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export const SAMPLE_RESUME_LINES = [
  'Asha Rao - Backend Engineer',
  'Experience: 4 years building payment systems at a fintech startup.',
  'Skills: TypeScript, Node.js, Express, PostgreSQL, Redis, AWS, Docker, microservices, Kafka.',
  'Project: Payment Gateway handling 2000 RPS with Redis caching and Kafka events',
  'Project: Ledger Service on PostgreSQL with double-entry bookkeeping',
  'Reduced p95 latency from 1.4s to 300ms by fixing N+1 queries and adding indexes.',
];
