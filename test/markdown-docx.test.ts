import { describe, expect, it } from 'vitest';
import { importDocx, paragraphsOf, validateDocument, type DocumentParagraph, type DocumentTable } from '@hivemagnus/canvas-word-codec';
import { markdownToWordDocument } from '../src/markdown-docx.js';
import { renderDocx } from '../src/document-render.js';

// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function paragraphs(markdown: string): DocumentParagraph[] {
  const { document } = markdownToWordDocument(markdown);
  validateDocument(document);
  return document.blocks.filter((block): block is DocumentParagraph => block.type === 'paragraph');
}
const text = (paragraph: DocumentParagraph | undefined) => paragraph?.runs.map(run => run.text).join('');

describe('Markdown to Word exchange document', () => {
  it('maps headings and inline formatting to styled runs', () => {
    const [heading, body] = paragraphs('## Plan &amp; scope\n\nPlain **bold** *italic* ~~old~~ `code` and [site](https://example.com/a).');
    expect(heading).toMatchObject({ style: { heading: 2, keepWithNext: true }, runs: [{ text: 'Plan & scope', style: { bold: true, size: 24 } }] });
    expect(body!.runs.map(run => [run.text, run.style])).toEqual([
      ['Plain ', {}], ['bold', { bold: true }], [' ', {}], ['italic', { italic: true }], [' ', {}], ['old', { strikeout: true }], [' ', {}],
      ['code', { font: 'Courier New', highlight: '#eeeeee' }], [' and ', {}],
      ['site', { hyperlink: 'https://example.com/a', underline: true, color: '#0563c1' }], ['.', {}]
    ]);
  });

  it('keeps non-HTTP link targets as text and never links other schemes', () => {
    const [body] = paragraphs('[mail](mailto:user@example.com), [js](javascript:alert(1)) and [top](#top)');
    expect(text(body)).toBe('mail (mailto:user@example.com), js (javascript:alert(1)) and top');
    expect(body!.runs.some(run => run.style.hyperlink)).toBe(false);
  });

  it('uses Word numbering for flat lists and nested bullets', () => {
    const blocks = paragraphs('- one\n- two\n  - inner\n\n1. first\n2. second\n');
    expect(blocks.map(block => [text(block), block.style.list, block.style.indent])).toEqual([
      ['one', 'bullet', undefined], ['two', 'bullet', undefined], ['inner', 'bullet', 72], ['first', 'number', undefined], ['second', 'number', undefined]
    ]);
  });

  it('writes numbers as text when Word numbering would restart or miscount', () => {
    const blocks = paragraphs('3. three\n4. four\n   - nested\n\n- [x] done\n- [ ] open\n');
    expect(blocks.map(block => [text(block), block.style])).toEqual([
      ['3.\tthree', { indent: 48, firstLineIndent: -24, after: 4 }],
      ['4.\tfour', { indent: 48, firstLineIndent: -24, after: 4 }],
      ['nested', { list: 'bullet', after: 4, indent: 72 }],
      ['\u2612 done', { list: 'bullet', after: 4 }],
      ['\u2610 open', { list: 'bullet', after: 4 }]
    ]);
  });

  it('indents block quotes and keeps code blocks verbatim', () => {
    const [quote, inner, code] = paragraphs('> said **this**\n> > and that\n\n```ts\nif (a < b) {\n  go();\n}\n```\n');
    expect(quote).toMatchObject({ style: { indent: 24 }, runs: [{ text: 'said ', style: { italic: true, color: '#555555' } }, { text: 'this', style: { italic: true, bold: true } }] });
    expect(inner).toMatchObject({ style: { indent: 48 } });
    expect(code!.runs).toEqual([expect.objectContaining({ text: 'if (a < b) {\n  go();\n}', style: { font: 'Courier New', size: 12, highlight: '#f4f4f4' } })]);
  });

  it('maps tables with a bold header, alignment and inline formatting', () => {
    const { document } = markdownToWordDocument('| Name | Total |\n|:--|--:|\n| **a** | 1 |\n| b |  |\n');
    const table = document.blocks[0] as DocumentTable;
    expect(table.type).toBe('table');
    expect(table.widths).toHaveLength(2);
    expect(table.rows.map(row => row.cells.map(cell => text(cell.paragraphs[0])))).toEqual([['Name', 'Total'], ['a', '1'], ['b', '']]);
    expect(table.rows[0]!.cells[1]!.paragraphs[0]).toMatchObject({ style: { alignment: 'right' }, runs: [{ style: { bold: true } }] });
    expect(table.rows[1]!.cells[0]!.paragraphs[0]!.runs[0]!.style).toEqual({ bold: true });
  });

  it('splits tables longer than the exchange format allows', () => {
    const rows = Array.from({ length: 150 }, (_, index) => `| ${index} |`).join('\n');
    const { document } = markdownToWordDocument(`| N |\n|---|\n${rows}\n`);
    validateDocument(document);
    const tables = document.blocks.filter((block): block is DocumentTable => block.type === 'table');
    expect(tables.map(table => table.rows.length)).toEqual([100, 51]);
  });

  it('embeds PNG data URIs, and leaves placeholders for other images and SVG figures', () => {
    const { document, assets } = markdownToWordDocument(`![dot](data:image/png;base64,${PNG}) ![remote](https://example.com/x.png)\n\n\`\`\`svg\n<svg xmlns="http://www.w3.org/2000/svg"/>\n\`\`\`\n\n---\n`);
    validateDocument(document);
    const [images, figure, rule] = document.blocks as DocumentParagraph[];
    expect(images!.runs[0]).toMatchObject({ text: '', style: {}, inlineImage: { assetId: 1, alt: 'dot', width: 1, height: 1 } });
    expect(assets.get(1)).toMatchObject({ mediaType: 'image/png' });
    expect(text(images)).toBe(' [image: remote]');
    expect(JSON.stringify(document)).not.toContain('x.png');
    expect(text(figure)).toContain('SVG figure omitted');
    expect(rule).toMatchObject({ style: { alignment: 'center' }, runs: [{ text: '* * *' }] });
  });

  it('removes characters Word cannot store and always produces a paragraph', () => {
    expect(text(paragraphs('a\u0001b\u000bc \ud800')[0])).toBe('abc \ufffd');
    expect(paragraphs('[x]: https://example.com\n')).toHaveLength(1);
  });
});

describe('DOCX rendering', () => {
  it('writes a DOCX whose text, headings and list items survive a re-import', async () => {
    const markdown = '# Quarterly report\n\nRevenue grew **12%** in [Q3](https://example.com/q3).\n\n## Risks\n\n- Supply\n- Hiring\n  - Engineers\n\n1. Plan\n2. Ship\n\n> Quoted note\n\n| Item | Cost |\n|---|---|\n| Disk | 10 |\n';
    const bytes = await renderDocx(markdown, 'Quarterly report');
    expect(Buffer.from(bytes).subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
    const imported = await importDocx(Buffer.from(bytes));
    const all = paragraphsOf(imported.document).map(paragraph => ({ text: paragraph.runs.map(run => run.text).join(''), heading: paragraph.style.heading, list: paragraph.style.list }));
    expect(all.filter(paragraph => paragraph.heading)).toEqual([{ text: 'Quarterly report', heading: 1, list: undefined }, { text: 'Risks', heading: 2, list: undefined }]);
    expect(all.filter(paragraph => paragraph.list).map(paragraph => [paragraph.text, paragraph.list])).toEqual([
      ['Supply', 'bullet'], ['Hiring', 'bullet'], ['Engineers', 'bullet'], ['Plan', 'number'], ['Ship', 'number']
    ]);
    expect(all.map(paragraph => paragraph.text)).toEqual(expect.arrayContaining(['Revenue grew 12% in Q3.', 'Quoted note', 'Item', 'Cost', 'Disk', '10']));
    const link = paragraphsOf(imported.document).flatMap(paragraph => paragraph.runs).find(run => run.text === 'Q3');
    expect(link?.style.hyperlink).toBe('https://example.com/q3');
  });

  it('round-trips an embedded image', async () => {
    const imported = await importDocx(Buffer.from(await renderDocx(`![dot](data:image/png;base64,${PNG})`, 'Figure')));
    expect(imported.assets).toHaveLength(1);
    expect(imported.assets[0]).toMatchObject({ mediaType: 'image/png' });
  });

  it('fails with no effect when the document exceeds the exchange format', async () => {
    const wide = `|${' c |'.repeat(101)}\n|${'---|'.repeat(101)}\n`;
    await expect(renderDocx(wide, 'Wide')).rejects.toMatchObject({ code: 'DOCX_RENDER_FAILED', message: expect.stringContaining('blocks.0') });
  });

});
