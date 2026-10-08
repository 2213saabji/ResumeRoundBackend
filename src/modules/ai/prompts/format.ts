/**
 * Wraps untrusted text (resume, candidate answers) in a tag, stripping anything that could
 * open or close that tag so the text cannot break out of its delimiter.
 */
export function dataBlock(tag: string, text: string): string {
  const breakout = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  return `<${tag}>\n${text.replace(breakout, '')}\n</${tag}>`;
}
