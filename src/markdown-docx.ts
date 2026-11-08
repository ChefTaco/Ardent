import { createHash } from 'node:crypto';
import { defaultLayout, type DocumentBlock, type DocumentParagraph, type DocumentRun, type DocxAsset, type ParagraphStyle,
  type TextStyle, type WordDocument } from '@hivemagnus/canvas-word-codec';
import { Lexer, type MarkedToken, type Token, type Tokens } from 'marked';

/** A Word exchange document built from Markdown, with the image bytes its runs reference. */
export type MarkdownWordDocument = { document: WordDocument; assets: Map<number, DocxAsset> };

const BODY_FONT = 'Calibri';
const BODY_SIZE = 14.67; // px: 11 pt
const MONO_FONT = 'Courier New';
const HEADING_SIZES = [29.33, 24, 20, 17.33, 16, 14.67];
const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const; // px: 22, 18, 15, 13, 12, 11 pt
const LIST_INDENT = 48; // px: the codec's numbering indent (0.5 in)
const NEST_INDENT = 24;
const QUOTE_INDENT = 24;
const MAX_TABLE_ROWS = 100;
const MAX_IMAGE_DATA_CHARS = 16 * 1024 * 1024;

type Context = { indent: number; depth: number; quote: boolean };

/** Narrow a lexer token by its type. Without extensions the lexer only emits the known token shapes. */
function is<K extends MarkedToken['type']>(token: Token, type: K): token is Extract<MarkedToken, { type: K }> {
  return token.type === type;
}

function children(token: Token): Token[] | undefined {
  return 'tokens' in token ? token.tokens : undefined;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9',
  reg: '\u00ae', trade: '\u2122', deg: '\u00b0', times: '\u00d7', middot: '\u00b7', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb', euro: '\u20ac' };

/** Resolve the character references the Markdown lexer leaves in text, in one pass. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (match, entity: string) => {
    if (entity[0] !== '#') return Object.hasOwn(NAMED_ENTITIES, entity) ? NAMED_ENTITIES[entity] ?? match : match;
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

/** Drop characters OOXML cannot carry; lone surrogates become U+FFFD. */
function xmlSafe(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
}

function httpUrl(href: string): string | undefined {
  if (href.length > 2048 || !/^https?:\/\//i.test(href) || !URL.canParse(href)) return undefined;
  return href;
}

/** Width and height of base64 PNG or JPEG bytes from a `data:` URI; anything else is not embedded. */
function dataImage(href: string): { bytes: Buffer; mediaType: 'image/png' | 'image/jpeg'; width: number; height: number } | undefined {
  const match = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(href.length <= MAX_IMAGE_DATA_CHARS ? href : '');
  if (!match) return undefined;
  const bytes = Buffer.from(match[2] ?? '', 'base64');
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a && bytes.toString('latin1', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width && height ? { bytes, mediaType: 'image/png', width, height } : undefined;
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset] !== 0xff) return undefined;
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = bytes.readUInt16BE(offset + 5);
        const width = bytes.readUInt16BE(offset + 7);
        return width && height ? { bytes, mediaType: 'image/jpeg', width, height } : undefined;
      }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
  }
  return undefined;
}

class WordBuilder {
  readonly blocks: DocumentBlock[] = [];
  readonly assets = new Map<number, DocxAsset>();
  private nextId = 0;
  private readonly contentWidth: number;

  constructor(readonly layout = defaultLayout()) {
    this.contentWidth = layout.width - layout.margins[1] - layout.margins[3];
  }

  id(prefix: string): string { return `${prefix}${++this.nextId}`; }

  run(text: string, style: TextStyle): DocumentRun { return { id: this.id('r'), text: xmlSafe(text), style }; }

  paragraph(runs: DocumentRun[], style: ParagraphStyle): DocumentParagraph {
    return { type: 'paragraph', id: this.id('p'), style, runs: runs.length ? runs : [this.run('', {})] };
  }

  /** Inline tokens to runs; adjacent runs with the same style are merged. */
  inline(tokens: Token[] | undefined, style: TextStyle, ctx: Context, runs: DocumentRun[] = []): DocumentRun[] {
    const text = (value: string, runStyle = style) => {
      if (!value) return;
      const last = runs.at(-1);
      if (last && !last.inlineImage && JSON.stringify(last.style) === JSON.stringify(runStyle)) last.text += xmlSafe(value);
      else runs.push(this.run(value, runStyle));
    };
    for (const token of tokens ?? []) {
      if (is(token, 'text')) { if (token.tokens?.length) this.inline(token.tokens, style, ctx, runs); else text(decodeEntities(token.text)); }
      else if (is(token, 'escape')) text(token.text);
      else if (is(token, 'strong')) this.inline(token.tokens, { ...style, bold: true }, ctx, runs);
      else if (is(token, 'em')) this.inline(token.tokens, { ...style, italic: true }, ctx, runs);
      else if (is(token, 'del')) this.inline(token.tokens, { ...style, strikeout: true }, ctx, runs);
      else if (is(token, 'codespan')) text(token.text, { ...style, font: MONO_FONT, highlight: '#eeeeee' });
      else if (is(token, 'br')) text('\n');
      else if (is(token, 'checkbox')) text(token.checked ? '\u2612 ' : '\u2610 ');
      else if (is(token, 'html')) text(/^<br\s*\/?>$/i.test(token.text.trim()) ? '\n' : token.text);
      else if (is(token, 'link')) {
        const url = httpUrl(token.href);
        if (url) this.inline(token.tokens, { ...style, hyperlink: url, underline: true, color: '#0563c1' }, ctx, runs);
        else {
          this.inline(token.tokens, style, ctx, runs);
          if (token.href && !token.href.startsWith('#') && token.href !== token.text) text(` (${token.href})`);
        }
      } else if (is(token, 'image')) {
        const data = dataImage(token.href);
        if (!data) { text(token.text ? `[image: ${decodeEntities(token.text)}]` : '[image]', { ...style, italic: true }); continue; }
        const assetId = this.assets.size + 1;
        this.assets.set(assetId, { bytes: data.bytes, mediaType: data.mediaType });
        const scale = Math.min(1, (this.contentWidth - ctx.indent) / data.width, 16384 / data.height);
        runs.push({ id: this.id('r'), text: '', style: {}, inlineImage: { assetId, sha256: createHash('sha256').update(data.bytes).digest('hex'),
          alt: xmlSafe(decodeEntities(token.text)).slice(0, 2000), width: Math.max(1, Math.round(data.width * scale)), height: Math.max(1, Math.round(data.height * scale)) } });
      } else if (children(token)?.length) this.inline(children(token), style, ctx, runs);
      else if ('text' in token && typeof token.text === 'string') text(decodeEntities(token.text));
    }
    return runs;
  }

  /** Paragraph style for body text at this nesting: quotes and list continuations indent. */
  private bodyStyle(ctx: Context, extra: ParagraphStyle = {}): ParagraphStyle {
    return { after: ctx.depth ? 4 : 8, ...(ctx.indent ? { indent: ctx.indent } : {}), ...extra };
  }

  private textStyle(ctx: Context): TextStyle { return ctx.quote ? { italic: true, color: '#555555' } : {}; }

  block(token: Token, ctx: Context): void {
    if (is(token, 'space') || is(token, 'def')) return;
    if (is(token, 'heading')) {
      const level = HEADING_LEVELS[Math.min(6, Math.max(1, token.depth)) - 1] ?? 1;
      this.blocks.push(this.paragraph(this.inline(token.tokens, { bold: true, size: HEADING_SIZES[level - 1] ?? BODY_SIZE }, ctx),
        { heading: level, keepWithNext: true, before: level <= 2 ? 13 : 8, after: 6, ...(ctx.indent ? { indent: ctx.indent } : {}) }));
    } else if (is(token, 'code')) {
      if (token.lang?.toLowerCase() === 'svg' && /<svg[\s>]/i.test(token.text))
        this.blocks.push(this.paragraph([this.run('[SVG figure omitted: vector figures are rendered in PDF output only]', { italic: true, color: '#777777' })], this.bodyStyle(ctx)));
      else this.blocks.push(this.paragraph([this.run(token.text || ' ', { font: MONO_FONT, size: 12, highlight: '#f4f4f4' })], this.bodyStyle(ctx)));
    } else if (is(token, 'blockquote')) {
      for (const child of token.tokens) this.block(child, { ...ctx, indent: ctx.indent + QUOTE_INDENT, quote: true });
    } else if (is(token, 'list')) this.list(token, ctx);
    else if (is(token, 'table')) this.table(token, ctx);
    else if (is(token, 'hr')) this.blocks.push(this.paragraph([this.run('* * *', { color: '#999999' })], { alignment: 'center', before: 4, after: 8 }));
    else if (is(token, 'html')) {
      if (token.text.trim()) this.blocks.push(this.paragraph([this.run(token.text.trim(), this.textStyle(ctx))], this.bodyStyle(ctx)));
    } else {
      // A paragraph, the text of a tight list item, or anything else with inline content.
      const runs = children(token) ? this.inline(children(token), this.textStyle(ctx), ctx)
        : 'text' in token && typeof token.text === 'string' ? [this.run(decodeEntities(token.text), this.textStyle(ctx))] : [];
      if (runs.length) this.blocks.push(this.paragraph(runs, this.bodyStyle(ctx)));
    }
  }

  /**
   * Bulleted lists always use Word numbering. The codec writes single-level lists that restart
   * whenever the list kind changes, so an ordered list uses Word numbering only when that numbers
   * it correctly (it starts at 1, no nested blocks interrupt it, and it does not directly follow
   * another numbered list); otherwise its numbers are written as text with a hanging indent.
   */
  private list(list: Tokens.List, ctx: Context): void {
    const content = (item: Tokens.ListItem) => item.tokens.filter(token => token.type !== 'space' && token.type !== 'checkbox');
    const previous = this.blocks.at(-1);
    const start = typeof list.start === 'number' ? list.start : 1;
    const native = !list.ordered || (start === 1 && list.items.every(item => content(item).length <= 1)
      && !(previous?.type === 'paragraph' && previous.style.list === 'number'));
    // Item text sits one numbering indent in at the top level and one hanging indent past its parent item's text.
    const indent = ctx.indent + (ctx.depth ? NEST_INDENT : LIST_INDENT);
    const nested: Context = { indent, depth: ctx.depth + 1, quote: ctx.quote };
    list.items.forEach((item, index) => {
      const [first, ...rest] = content(item);
      const checkbox = item.tokens.find(token => is(token, 'checkbox'));
      const runs: DocumentRun[] = [];
      if (!native) runs.push(this.run(`${start + index}.\t`, this.textStyle(ctx)));
      if (checkbox) runs.push(this.run(checkbox.checked ? '\u2612 ' : '\u2610 ', this.textStyle(ctx)));
      if (first && (is(first, 'text') || is(first, 'paragraph'))) this.inline(first.tokens ?? [first], this.textStyle(ctx), nested, runs);
      else if (first) rest.unshift(first);
      const style: ParagraphStyle = native ? { list: list.ordered ? 'number' : 'bullet', after: 4 } : { indent, firstLineIndent: -NEST_INDENT, after: 4 };
      if (native && indent !== LIST_INDENT) style.indent = indent;
      this.blocks.push(this.paragraph(runs, style));
      for (const child of rest) this.block(child, nested);
    });
  }

  /** Tables keep their header row, alignment and inline formatting; long tables are split every 100 rows. */
  private table(table: Tokens.Table, ctx: Context): void {
    const columns = table.header.length;
    const width = Math.max(1, Math.floor((this.contentWidth - ctx.indent) / columns));
    const row = (cells: Tokens.TableCell[], header: boolean) => ({ id: this.id('tr'), cells: Array.from({ length: columns }, (_, column) => {
      const cell = cells[column];
      const align = table.align[column];
      // An image in a cell is scaled to the cell width.
      const runs = this.inline(cell?.tokens, header ? { bold: true } : {}, { ...ctx, indent: this.contentWidth - width });
      return { id: this.id('tc'), paragraphs: [this.paragraph(runs, align ? { alignment: align } : {})] };
    }) });
    const rows = [row(table.header, true), ...table.rows.map(cells => row(cells, false))];
    for (let offset = 0; offset < rows.length; offset += MAX_TABLE_ROWS)
      this.blocks.push({ type: 'table', id: this.id('t'), widths: Array.from({ length: columns }, () => width), rows: rows.slice(offset, offset + MAX_TABLE_ROWS) });
    this.blocks.push(this.paragraph([], { after: 4 }));
  }
}

/**
 * Map Markdown (GFM: headings, paragraphs, emphasis, strikethrough, inline code, links, nested
 * lists and task lists, block quotes, code blocks, tables and rules) to a Word exchange document.
 * Images are embedded only from PNG or JPEG `data:` URIs; nothing is fetched or read.
 */
export function markdownToWordDocument(markdown: string): MarkdownWordDocument {
  const builder = new WordBuilder({ ...defaultLayout(), font: BODY_FONT, fontSize: BODY_SIZE });
  const tokens = new Lexer({ gfm: true }).lex(markdown.replace(/\r\n?/g, '\n'));
  for (const token of tokens) builder.block(token, { indent: 0, depth: 0, quote: false });
  if (!builder.blocks.length) builder.blocks.push(builder.paragraph([], {}));
  return { document: { schemaVersion: 1, layout: builder.layout, changes: [], comments: [], blocks: builder.blocks }, assets: builder.assets };
}
