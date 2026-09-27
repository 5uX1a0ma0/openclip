export type CleanLinksResult = {
  text: string;
  changedLinks: number;
  removedParams: number;
};

const globalParams = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'gbraid', 'wbraid', 'mc_cid', 'mc_eid']);
const signedParams = new Set([
  'signature', 'sig', 'sign', 'oauth_signature', 'q-signature', 'auth_key',
  'x-amz-signature', 'x-goog-signature', 'x-oss-signature', 'x-cos-signature',
  'x-ms-signature', 'x-bce-signature', 'cloudfront-signature'
]);
const trailingPunctuation = /[.,;:!?。，；：！？、…]/u;

function trimLink(candidate: string): [string, string] {
  let end = candidate.length;
  while (end > 0) {
    const last = candidate[end - 1];
    if (trailingPunctuation.test(last) || /[)\]}）】》〉]/u.test(last)) {
      if (last === ')' && (candidate.slice(0, end).match(/\(/g) || []).length >= (candidate.slice(0, end).match(/\)/g) || []).length) break;
      if (last === ']' && (candidate.slice(0, end).match(/\[/g) || []).length >= (candidate.slice(0, end).match(/\]/g) || []).length) break;
      end -= 1;
      continue;
    }
    break;
  }
  return [candidate.slice(0, end), candidate.slice(end)];
}

function cleanLink(link: string): { text: string; removed: number } {
  // URL accepts malformed escapes and normalizes backslashes; such links are ambiguous.
  if (link.includes('\\') || /%(?![0-9a-fA-F]{2})/.test(link)) return { text: link, removed: 0 };
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return { text: link, removed: 0 };
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    return { text: link, removed: 0 };
  }
  const queryStart = link.indexOf('?');
  const fragmentStart = link.indexOf('#');
  if (queryStart < 0 || (fragmentStart >= 0 && queryStart > fragmentStart)) return { text: link, removed: 0 };
  const queryEnd = fragmentStart < 0 ? link.length : fragmentStart;
  const rawQuery = link.slice(queryStart + 1, queryEnd);
  const parts = rawQuery.split('&');
  let names: string[];
  try {
    names = parts.map((part) => decodeURIComponent(part.split('=', 1)[0].replace(/\+/g, ' ')).toLowerCase());
  } catch {
    return { text: link, removed: 0 };
  }
  if (names.some((name) => signedParams.has(name))) return { text: link, removed: 0 };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const bilibili = host === 'bilibili.com' || host.endsWith('.bilibili.com');
  const youtube = host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host.endsWith('.youtu.be');
  const kept = parts.filter((_, i) => {
    const name = names[i];
    return !(name.startsWith('utm_') || globalParams.has(name) ||
      (bilibili && (name === 'spm_id_from' || name === 'vd_source')) ||
      (youtube && (name === 'si' || name === 'feature')));
  });
  const removed = parts.length - kept.length;
  if (!removed) return { text: link, removed: 0 };
  return {
    text: link.slice(0, queryStart) + (kept.length ? `?${kept.join('&')}` : '') + link.slice(queryEnd),
    removed
  };
}

export function cleanTrackingLinks(text: string): CleanLinksResult {
  let changedLinks = 0;
  let removedParams = 0;
  const cleaned = text.replace(/https?:\/\/(?:(?![,;!?]https?:\/\/)[^\s<>"'“”‘’，。；：！？、（）【】《》〈〉…])+/giu, (candidate, offset: number) => {
    // Ignore protocol strings embedded in non-HTTP links and identifiers.
    if (offset > 0 && /[\w/=?&%:-]/.test(text[offset - 1])) return candidate;
    const [link, punctuation] = trimLink(candidate);
    const result = cleanLink(link);
    if (result.removed) {
      changedLinks += 1;
      removedParams += result.removed;
    }
    return result.text + punctuation;
  });
  return { text: cleaned, changedLinks, removedParams };
}
