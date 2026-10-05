import { normalizeTargetUrl } from './target-urls.js';
import type { AnyPostRaw, Target } from './types.js';

/** Company-name suffix tokens that carry no identity. Stripped as whole tokens, never as substrings,
 *  so "Retool" does not become "Ret" and "Sanofi" does not become "Sanof". */
const NOISE_TOKENS = new Set([
    'inc',
    'inc.',
    'llc',
    'ltd',
    'limited',
    'corp',
    'gmbh',
    'bv',
    'ai',
    'io',
    'com',
    'hq',
    'labs',
    'the',
]);

/** Lowercase, drop every non-alphanumeric character. "Grow With Clay" and "grow-with-clay" collapse to the same string. */
export function normalizeNameForMatch(value: string | null | undefined): string {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

/** Same collapse, but with meaningless company suffixes removed token-wise first. */
export function normalizeCompanyName(value: string | null | undefined): string {
    const tokens = String(value ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .filter((t) => !NOISE_TOKENS.has(t));
    return tokens.join('');
}

function slugFromLinkedInUrl(url: string | null | undefined): string {
    if (!url) return '';
    const m = /linkedin\.com\/(?:[a-z]{2}\/)?(?:company|school|in)\/([^/?#]+)/.exec(normalizeTargetUrl(url));
    return m ? m[1] : '';
}

/** Two identities match if they collapse to the same string, or if one contains the other and both are long
 *  enough for containment to mean something. Slugs like `grow-with-clay` legitimately hold a name like `Clay`. */
function identityMatches(candidate: string, slug: string): boolean {
    if (!candidate || !slug) return false;
    if (candidate === slug) return true;
    if (candidate.length < 4 || slug.length < 4) return false;
    return candidate.includes(slug) || slug.includes(candidate);
}

/**
 * Assert that the posts we got back actually belong to the target we asked for.
 *
 * This exists because the upstream profile Actor can return a stranger's posts for a valid-looking slug
 * with no error at all — during research, `heyreach` silently returned an unrelated person's job advert.
 * A silently wrong target poisons the entire lead list, so a mismatch discards the target's posts.
 */
export function authorMatchesTarget(
    target: Target,
    posts: AnyPostRaw[],
): { ok: true } | { ok: false; requested: string; returned: string } {
    if (!posts.length) return { ok: true };

    const slug = normalizeNameForMatch(target.slug);
    const slugLoose = normalizeCompanyName(target.slug);
    const candidates: string[] = [];

    for (const post of posts.slice(0, 5)) {
        const author = post.author ?? {};
        if (target.type === 'company') {
            // The company Actor exposes no username or headline — name, company_url and source_company is all there is.
            candidates.push(slugFromLinkedInUrl(author.company_url));
            candidates.push(post.source_company ?? '');
            candidates.push(author.name ?? '');
        } else {
            candidates.push(author.username ?? '');
            candidates.push(slugFromLinkedInUrl(author.profile_url));
            candidates.push(post.profile_input ?? '');
            candidates.push(author.name ?? '');
        }
    }

    const cleaned = candidates.map((c) => c.trim()).filter(Boolean);
    if (!cleaned.length) return { ok: true }; // nothing to compare against; don't invent a failure

    for (const candidate of cleaned) {
        if (identityMatches(normalizeNameForMatch(candidate), slug)) return { ok: true };
        if (identityMatches(normalizeCompanyName(candidate), slugLoose)) return { ok: true };
    }

    return { ok: false, requested: target.slug, returned: cleaned[0] };
}
