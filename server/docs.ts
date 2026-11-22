import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

const MAX_CHARS = 60000;

/** Turns uploaded requirement files into plain text for the agent. */
export async function extractDocsText(files: { originalname: string; buffer: Buffer }[]): Promise<string> {
  const parts: string[] = [];
  for (const f of files) {
    const name = f.originalname;
    const ext = name.toLowerCase().split('.').pop() || '';
    let text = '';
    try {
      if (ext === 'pdf') {
        const parser = new PDFParse({ data: new Uint8Array(f.buffer) });
        text = (await parser.getText()).text;
        await parser.destroy().catch(() => {});
      } else if (ext === 'docx') {
        text = (await mammoth.extractRawText({ buffer: f.buffer })).value;
      } else if (['md', 'txt', 'markdown', 'csv', 'json', 'feature'].includes(ext)) {
        text = f.buffer.toString('utf8');
      } else {
        throw new Error(`"${name}" is not a supported file type. Use PDF, DOCX, MD or TXT.`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('supported file type')) throw e;
      throw new Error(`Could not read "${name}". Is the file damaged or password-protected?`);
    }
    parts.push(`--- ${name} ---\n${text.replace(/\n{3,}/g, '\n\n').trim()}`);
  }
  const all = parts.join('\n\n');
  return all.length > MAX_CHARS ? all.slice(0, MAX_CHARS) + '\n… (documents cut for length)' : all;
}
