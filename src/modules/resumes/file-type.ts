export interface ResumeFileType {
  mimeType:
    'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  ext: 'pdf' | 'docx';
}

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
// Zip entry names are stored uncompressed, so a .docx always contains these byte strings.
const DOCX_MARKERS = [Buffer.from('[Content_Types].xml'), Buffer.from('word/')];

/**
 * Identifies a resume by its content (magic bytes), never by extension or the client's
 * Content-Type, both of which are attacker-controlled.
 */
export function detectResumeFileType(buf: Buffer): ResumeFileType | null {
  if (buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return { mimeType: 'application/pdf', ext: 'pdf' };
  }
  if (
    buf.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC) &&
    DOCX_MARKERS.every((m) => buf.includes(m))
  ) {
    return {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ext: 'docx',
    };
  }
  return null;
}
