import type { Target, TargetType, UnresolvableTarget, UrlKind } from './types.js';

/**
 * Strip protocol, www., locale subdomain, locale path segment, query string, fragment and trailing slashes.
 * Everything downstream assumes the output of this function.
 */
export function normalizeTargetUrl(raw: string): string {
    let s = String(raw ?? '')
        .trim()
        .toLowerCase();
    if (!s) return '';
    s = s.split('#')[0];
    s = s.split('?')[0];
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    s = s.replace(/^(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com/, 'linkedin.com');
    s = s.replace(/\/+$/, '');
    return s;
}

/** Recognizes URL forms, the explicit `company:slug` / `profile:slug` forms, and nothing else. */
export function classifyTarget(raw: string): Target | UnresolvableTarget {
    const original = String(raw ?? '').trim();

    const explicit = /^(company|profile)\s*:\s*([^\s/]+)$/i.exec(original);
    if (explicit) {
        const type = explicit[1].toLowerCase() as TargetType;
        const kind: UrlKind = type === 'profile' ? 'in' : 'company';
        const slug = explicit[2].toLowerCase();
        return { type, slug, kind, canonicalUrl: canonicalUrlFor(kind, slug), raw: original };
    }

    const s = normalizeTargetUrl(original);
    // An optional 2-letter locale segment may sit between the host and the path kind.
    const m = /^linkedin\.com\/(?:[a-z]{2}\/)?(company|school|in)\/([^/]+)/.exec(s);
    if (m) {
        const kind = m[1] as UrlKind;
        const type: TargetType = kind === 'in' ? 'profile' : 'company';
        const slug = m[2];
        return { type, slug, kind, canonicalUrl: canonicalUrlFor(kind, slug), raw: original };
    }

    return { raw: original, reason: 'unresolvable_target' };
}

function canonicalUrlFor(kind: UrlKind, slug: string): string {
    return `https://www.linkedin.com/${kind}/${slug}`;
}

export function isUnresolvable(t: Target | UnresolvableTarget): t is UnresolvableTarget {
    return 'reason' in t;
}

/** Classify every input, drop duplicates by type+slug, and separate out the ones we refuse to guess at. */
export function resolveTargets(raws: string[]): { targets: Target[]; unresolvable: UnresolvableTarget[] } {
    const targets: Target[] = [];
    const unresolvable: UnresolvableTarget[] = [];
    const seen = new Set<string>();

    for (const raw of raws ?? []) {
        if (!String(raw ?? '').trim()) continue;
        const t = classifyTarget(raw);
        if (isUnresolvable(t)) {
            unresolvable.push(t);
            continue;
        }
        const key = `${t.type}:${t.slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(t);
    }

    return { targets, unresolvable };
}
