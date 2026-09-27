import { describe, expect, it } from 'vitest';
import { cleanTrackingLinks } from './tracking_links';

describe('cleanTrackingLinks', () => {
  it('recognizes adjacent links and Chinese punctuation without swallowing the surrounding text', () => {
    expect(cleanTrackingLinks('链接：https://a.test/?utm_source=x，下一条：https://b.test/?fbclid=y。\nhttps://c.test/?gclid=z;https://d.test/?dclid=w!').text)
      .toBe('链接：https://a.test/，下一条：https://b.test/。\nhttps://c.test/;https://d.test/!');
  });

  it('removes only the named global rules, including repeats and encoded parameter names', () => {
    const names = ['utm_source', 'UTM_MEDIUM', 'fbclid', 'gclid', 'dclid', 'msclkid', 'gbraid', 'wbraid', 'mc_cid', 'mc_eid', '%75tm_campaign', 'fbclid'];
    const input = `https://x.test/path?${names.map((name) => `${name}=value`).join('&')}&id=1&q=a+b&page=2&t=40&code=提取码&token=auth&empty=&id=2#frag`;
    expect(cleanTrackingLinks(input)).toEqual({ text: 'https://x.test/path?id=1&q=a+b&page=2&t=40&code=提取码&token=auth&empty=&id=2#frag', changedLinks: 1, removedParams: names.length });
  });

  it.each(['signature', 'sig', 'sign', 'oauth_signature', 'q-signature', 'auth_key', 'X-Amz-Signature', 'X-Goog-Signature'])('skips signed URLs with %s', (name) => {
    const input = `https://x.test/?utm_source=x&${name}=signed`;
    expect(cleanTrackingLinks(input).text).toBe(input);
  });

  it('keeps nested URLs, unsupported protocols, functional domain params and malformed escapes intact', () => {
    const input = 'https://x.test/?next=https%3A%2F%2Fy.test%2F%3Futm_source%3Dx&utm_source=outer ftp://https://x.test/?utm_source=x https://x.test/%zz?utm_source=x https://x.test/?q=%z&utm_source=x https://evil-youtube.com/?si=x';
    expect(cleanTrackingLinks(input).text).toBe('https://x.test/?next=https%3A%2F%2Fy.test%2F%3Futm_source%3Dx ftp://https://x.test/?utm_source=x https://x.test/%zz?utm_source=x https://x.test/?q=%z&utm_source=x https://evil-youtube.com/?si=x');
  });

  it('handles subdomains, bare tracking parameters, empty segments and balanced parentheses', () => {
    expect(cleanTrackingLinks('[https://www.bilibili.com/(video)?vd_source&spm_id_from=x&id=2] https://m.youtube.com/watch?si=x&v=id&t=4 https://x.test/?&utm_source=x&&q=a(b)#part').text)
      .toBe('[https://www.bilibili.com/(video)?id=2] https://m.youtube.com/watch?v=id&t=4 https://x.test/?&&q=a(b)#part');
  });
  it('cleans several links while preserving prose, punctuation, repeats, encoding and fragments', () => {
    const input = '看 https://example.com/?q=a%2Bb&utm_source=x&q=二&fbclid=1#part，and (https://youtu.be/id?t=42&si=abc)!';
    expect(cleanTrackingLinks(input)).toEqual({
      text: '看 https://example.com/?q=a%2Bb&q=二#part，and (https://youtu.be/id?t=42)!',
      changedLinks: 2, removedParams: 3
    });
  });

  it('preserves functional and authentication params, domains, signed URLs and invalid URLs', () => {
    const input = 'https://notbilibili.com/?spm_id_from=x&code=abc https://bilibili.com/video?id=1&vd_source=x https://youtube.com.evil.test/?si=x https://x.test/?X-Amz-Signature=abc&utm_source=x https://%zz/?utm_source=x';
    expect(cleanTrackingLinks(input).text).toBe('https://notbilibili.com/?spm_id_from=x&code=abc https://bilibili.com/video?id=1 https://youtube.com.evil.test/?si=x https://x.test/?X-Amz-Signature=abc&utm_source=x https://%zz/?utm_source=x');
  });

  it('is idempotent and preserves encoded values and fragment text', () => {
    const first = cleanTrackingLinks('https://x.test/?a=%26%3D&a=2&utm_x=1#utm_y=2');
    expect(first).toEqual({ text: 'https://x.test/?a=%26%3D&a=2#utm_y=2', changedLinks: 1, removedParams: 1 });
    expect(cleanTrackingLinks(first.text)).toEqual({ ...first, changedLinks: 0, removedParams: 0 });
  });
});
