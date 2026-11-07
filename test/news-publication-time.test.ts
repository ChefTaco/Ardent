import { describe, expect, it } from 'vitest';
import { newsPublicationTime, newsStructuredPublicationTime } from '../src/news.js';

describe('publisher publication times', () => {
  const url = 'https://publisher.test/story';
  const article = (changes: Record<string, unknown> = {}) => ({ '@type': 'NewsArticle',
    mainEntityOfPage: { '@type': 'WebPage', '@id': url }, datePublished: '2026-10-22T04:00:00-05:00', ...changes });
  const script = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
  it('recovers an explicit publication date from the exact article structured data in the same extraction', () => {
    expect(newsPublicationTime({}, 'October 22, 2026 4:00 AM', script(article()), url)).toBe('2026-10-22T04:00:00-05:00');
    expect(newsStructuredPublicationTime(script({ '@graph': [article()] }), url)).toBe('2026-10-22T04:00:00-05:00');
    expect(newsStructuredPublicationTime(script([article({ '@id': url + '#article' })]), url)).toBe('2026-10-22T04:00:00-05:00');
  });
  it('refuses unrelated pages, mismatched identities, update-only, zone-less, impossible and conflicting dates', () => {
    for (const change of [
      { mainEntityOfPage: { '@id': 'https://other.test/story' } },
      { url: 'https://other.test/story' }, { '@type': 'Event' },
      { datePublished: undefined, dateModified: '2026-10-22T04:00:00-05:00' },
      { datePublished: '2026-10-22T04:00:00' }, { datePublished: '2026-02-30T04:00:00-05:00' }
    ]) expect(newsStructuredPublicationTime(script(article(change)), url)).toBeNull();
    expect(newsStructuredPublicationTime(script([article(), article({ datePublished: '2026-10-21T04:00:00-05:00' })]), url)).toBeNull();
    expect(newsStructuredPublicationTime(script({ datePublished: '2026-10-22T04:00:00-05:00' }), url)).toBeNull();
  });
  it('bounds structured publisher parsing and ignores executable scripts or broken JSON', () => {
    expect(newsStructuredPublicationTime('<script>'+JSON.stringify(article())+'</script>', url)).toBeNull();
    expect(newsStructuredPublicationTime('<script type="application/ld+json">broken</script>'+script(article()), url)).not.toBeNull();
    expect(newsStructuredPublicationTime(script(article({ text: 'x'.repeat(65_537) })), url)).toBeNull();
    expect(newsStructuredPublicationTime(script(Array.from({ length: 65 }, () => article())), url)).toBeNull();
    expect(newsStructuredPublicationTime('x'.repeat(2 * 1024 * 1024 + 1)+script(article()), url)).toBeNull();
  });
  it('recognizes the retained CBC Posted byline without treating an update as publication', () => {
    expect(newsPublicationTime({}, 'CBC News · Posted: Oct 05, 2026 5:00 AM EDT | Last Updated: 1 hour ago'))
      .toBe('2026-10-05T09:00:00.000Z');
    expect(newsPublicationTime({}, 'Posted: Oct. 05, 2026 5:00 AM EDT')).toBe('2026-10-05T09:00:00.000Z');
    expect(newsPublicationTime({}, 'Oct. 5, 2026 9:45 am UTC Updated')).toBeNull();
    expect(newsPublicationTime({}, 'Posted: Oct 05, 2026 5:00 AM')).toBeNull();
    expect(newsPublicationTime({}, 'Posted: Feb 30, 2026 5:00 AM EDT')).toBeNull();
  });
  it('uses the explicit publisher offset and never the host timezone', () => {
    expect(newsPublicationTime({ publishedTime: '2026-10-01T05:15:00-04:00' }, '')).toBe('2026-10-01T05:15:00-04:00');
    expect(newsPublicationTime({ publishedTime: '2026-10-01T05:15-04:00' }, '')).toBe('2026-10-01T05:15-04:00');
    expect(newsPublicationTime({ publishedTime: '2026-10-01T09:15:00' }, '')).toBeNull();
    expect(newsPublicationTime({ publishedTime: '2026-10-01' }, '')).toBeNull();
  });
  it('uses the publisher Parsely date when preferred metadata omitted its timezone', () => {
    const metadata = { publishedTime: '2026-10-07T04:18:48.187',
      'article:published_time': '2026-10-07T04:18:48.187',
      'parsely-pub-date': '2026-10-07T00:18:48-0400' };
    expect(newsPublicationTime(metadata, 'By: Hannah Pedeferri\nPosted\nBILLINGS — Community discussion'))
      .toBe('2026-10-07T00:18:48-0400');
    expect(newsPublicationTime({ 'parsely-pub-date': '2026-10-07T00:18:48' }, '')).toBeNull();
    expect(newsPublicationTime({ 'parsely-pub-date': '2026-02-30T00:18:48-0400' }, '')).toBeNull();
    expect(newsPublicationTime({ modifiedTime: '2026-10-07T00:18:48-0400' }, '')).toBeNull();
  });
  it('recovers an exact publication byline with a stated timezone and rejects ambiguous or impossible dates', () => {
    expect(newsPublicationTime({ publishedTime: '2026-10-01T09:15:00' },
      'Published October 1, 2026 at 5:15 AM EDT')).toBe('2026-10-01T09:15:00.000Z');
    expect(newsPublicationTime({}, 'Published October 1, 2026 at 5:15 AM')).toBeNull();
    expect(newsPublicationTime({}, 'Published February 30, 2026 at 5:15 AM EST')).toBeNull();
  });
});
