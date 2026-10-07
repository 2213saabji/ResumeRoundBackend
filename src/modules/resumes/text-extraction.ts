import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import type { ResumeFileType } from './file-type.js';

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Runs only in the worker process: parsing untrusted documents never happens on the API. */
export async function extractResumeText(
  buf: Buffer,
  mimeType: ResumeFileType['mimeType'] | string,
): Promise<string> {
  if (mimeType === 'application/pdf') {
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const result = await parser.getText();
      return normalizeWhitespace(result.text);
    } finally {
      await parser.destroy();
    }
  }
  const result = await mammoth.extractRawText({ buffer: buf });
  return normalizeWhitespace(result.value);
}
