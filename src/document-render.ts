import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import pdfMake from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { ProvenNoEffectError } from './tools.js';

/** Renders Markdown to DOCX bytes. */
export type DocxWriter = (markdown: string, options: { title: string }) => Promise<Uint8Array>;

/**
 * The DOCX writer. This build has none: `document_render` with `format: 'docx'`
 * fails with DOCX_UNAVAILABLE and no effect. Assign the canvas-word codec writer
 * here once that package is published; nothing else needs to change.
 */
const docxWriter = undefined as DocxWriter | undefined;

export const MAX_RENDER_SOURCE_CHARS = 200_000;

export async function renderDocx(markdown: string, title: string): Promise<Uint8Array> {
  if (!docxWriter) throw new ProvenNoEffectError('DOCX rendering is not available in this build', 'DOCX_UNAVAILABLE');
  return docxWriter(markdown, { title });
}

const fontRoot = join(dirname(createRequire(import.meta.url).resolve('pdfmake/package.json')), 'build', 'fonts', 'Roboto');
let configured = false;
function configurePdfMake(): void {
  if (configured) return;
  // Documents come from model output: never fetch a URL or read a file other than the bundled fonts.
  pdfMake.setUrlAccessPolicy(() => false);
  pdfMake.setLocalAccessPolicy(path => path.startsWith(fontRoot + sep));
  pdfMake.setFonts({ Roboto: { normal: join(fontRoot, 'Roboto-Regular.ttf'), bold: join(fontRoot, 'Roboto-Medium.ttf'),
    italics: join(fontRoot, 'Roboto-Italic.ttf'), bolditalics: join(fontRoot, 'Roboto-MediumItalic.ttf') } });
  configured = true;
}

type Inline = string | { text: string; bold?: boolean; italics?: boolean; background?: string; link?: string; decoration?: 'underline' };

/** Bold, italics, inline code and links. Images keep only their alternative text. */
export function inlineMarkdown(source: string): Inline[] {
  const parts: Inline[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(!?\[[^\]]*\]\([^)\s]+\))/g;
  let last = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (match.index > last) parts.push(source.slice(last, match.index));
    const token = match[0];
    if (match[1]) parts.push({ text: token.slice(1, -1), background: '#eeeeee' });
    else if (match[2]) parts.push({ text: token.slice(2, -2), bold: true });
    else if (match[3]) parts.push({ text: token.slice(1, -1), italics: true });
    else {
      const link = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      const label = link?.[2] ?? token;
      const url = link?.[3] ?? '';
      if (link?.[1]) parts.push({ text: label ? `[${label}]` : '[image]', italics: true });
      else if (/^https?:\/\//i.test(url)) parts.push({ text: label || url, link: url, decoration: 'underline' });
      else parts.push(label);
    }
    last = match.index + token.length;
  }
  if (last < source.length) parts.push(source.slice(last));
  return parts;
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

/** Convert Markdown (headings, paragraphs, lists, quotes, tables, code and ```svg blocks) to pdfmake content. */
export function markdownToPdfContent(markdown: string): Content[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const content: Content[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) content.push({ text: inlineMarkdown(paragraph.join(' ')), margin: [0, 0, 0, 8] });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const fence = /^\s*```\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (index++; index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? ''); index++) body.push(lines[index] ?? '');
      const code = body.join('\n');
      if (fence[1]?.toLowerCase() === 'svg' && /<svg[\s>]/i.test(code)) content.push({ svg: code, fit: [480, 640], margin: [0, 0, 0, 8] });
      else content.push({ table: { widths: ['*'], body: [[{ text: code || ' ', fontSize: 9, preserveLeadingSpaces: true }]] },
        layout: 'noBorders', fillColor: '#f4f4f4', margin: [0, 0, 0, 8] });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]?.length ?? 1;
      content.push({ text: inlineMarkdown(heading[2] ?? ''), bold: true, fontSize: [22, 18, 15, 13, 12, 11][level - 1] ?? 11, margin: [0, level <= 2 ? 10 : 6, 0, 6] });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#999999' }], margin: [0, 4, 0, 8] });
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[index + 1] ?? '')) {
      flush();
      const header = cells(line);
      const rows: string[][] = [];
      for (index += 2; index < lines.length && /^\s*\|/.test(lines[index] ?? ''); index++) rows.push(cells(lines[index] ?? ''));
      index--;
      const width = header.length;
      content.push({ table: { headerRows: 1, widths: Array.from({ length: width }, () => '*'),
        body: [header.map(cell => ({ text: inlineMarkdown(cell), bold: true })),
          ...rows.map(row => Array.from({ length: width }, (_, column) => ({ text: inlineMarkdown(row[column] ?? '') })))] },
      fontSize: 10, margin: [0, 0, 0, 8] });
      continue;
    }
    const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      flush();
      const ordered = /\d/.test(list[1] ?? '');
      const items: Content[] = [];
      for (; index < lines.length; index++) {
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index] ?? '');
        if (!item || /\d/.test(item[1] ?? '') !== ordered) break;
        items.push({ text: inlineMarkdown(item[2] ?? '') });
      }
      index--;
      content.push(ordered ? { ol: items, margin: [0, 0, 0, 8] } : { ul: items, margin: [0, 0, 0, 8] });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; index < lines.length && /^\s*>/.test(lines[index] ?? ''); index++) quoted.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
      index--;
      content.push({ text: inlineMarkdown(quoted.join(' ')), italics: true, color: '#555555', margin: [12, 0, 0, 8] });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return content.length ? content : [{ text: ' ' }];
}

/** Render Markdown to a PDF. Remote images and local files are never read. */
export async function renderPdf(markdown: string, title: string): Promise<Uint8Array> {
  configurePdfMake();
  const definition: TDocumentDefinitions = {
    info: { title, creator: 'Ardent', producer: 'Ardent' },
    pageSize: 'A4', pageMargins: [40, 48, 40, 48],
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.2 },
    content: markdownToPdfContent(markdown)
  };
  return new Uint8Array(await pdfMake.createPdf(definition).getBuffer());
}
