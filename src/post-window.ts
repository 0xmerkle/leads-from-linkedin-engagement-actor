import type { AnyPostRaw, Input, Post, Target } from './types.js';

/** Posts per upstream page. Deliberately well below the upstream maximum of 100: you are billed per post
 *  *fetched*, so asking for 100 posts to find the four inside a one-week window costs 25x what it should. */
export const POSTS_PAGE_SIZE = 25;

/** Safety cap per target, no longer an input. Bounds spend on a target that posts twenty times a day. */
export const MAX_POSTS_PER_TARGET = 25;

/** Backstop against a pathological pagination loop, independent of maxPostsPerTarget. */
export const MAX_PAGES = 20;

const WINDOW_MS: Record<Input['postedWithin'], number> = {
    '24h': 24 * 60 * 60 * 1000,
    '48h': 48 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    '2weeks': 14 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
};

/** Decoupled from `Input` so an explicit cutoff stays available to callers even though it is no longer
 *  an Actor input — scheduled runs elsewhere may still want a precise boundary. */
export interface WindowSpec {
    postedWithin: Input['postedWithin'];
    postedAfter?: string;
}

/** `postedAfter` wins when it parses; otherwise the window is measured back from now. */
export function resolveCutoff(
    input: WindowSpec,
    now: number = Date.now(),
): { cutoffMs: number; resolvedFrom: string; postedAfterIso: string } {
    if (input.postedAfter) {
        const parsed = Date.parse(input.postedAfter);
        if (Number.isFinite(parsed)) {
            return { cutoffMs: parsed, resolvedFrom: 'postedAfter', postedAfterIso: new Date(parsed).toISOString() };
        }
    }
    const span = WINDOW_MS[input.postedWithin] ?? WINDOW_MS.week;
    const cutoffMs = now - span;
    return {
        cutoffMs,
        resolvedFrom: input.postedWithin ?? 'week',
        postedAfterIso: new Date(cutoffMs).toISOString(),
    };
}

/** Upstream sends unix seconds in some records and milliseconds in others. Normalize to ms, or null. */
export function postedAtMs(raw: AnyPostRaw): number | null {
    const ts = raw.posted_at?.timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
        return ts < 1e12 ? Math.round(ts * 1000) : Math.round(ts);
    }
    const date = raw.posted_at?.date;
    if (date) {
        const parsed = Date.parse(date);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

/**
 * Flatten the two incompatible upstream post shapes into one.
 * The company Actor uses post_url/activity_urn; the profile Actor uses url/urn.activity_urn.
 * For a repost the visible body lives in reshared_post.text, so that is what phrase-skipping and
 * the excerpt must read.
 */
export function normalizePost(raw: AnyPostRaw, target: Target): Post | null {
    const postUrl = raw.post_url ?? raw.url ?? '';
    const postId = raw.activity_urn ?? raw.urn?.activity_urn ?? raw.full_urn ?? postUrl;
    if (!postUrl && !postId) return null;

    const ms = postedAtMs(raw);
    const own = (raw.text ?? '').trim();
    const reshared = (raw.reshared_post?.text ?? '').trim();
    const text = own || reshared;

    return {
        postId: String(postId),
        postUrl,
        text,
        postedAt: ms ?? Number.NaN,
        postedAtIso: ms ? new Date(ms).toISOString() : '',
        postType: raw.post_type ?? '',
        targetSlug: target.slug,
        targetType: target.type,
    };
}

/**
 * Collapse posts that are the same post.
 *
 * Two targets routinely surface one post: a company page lists a reshare of its own content, and the
 * person who wrote that reshare is a target in their own right. Pagination can also hand back an
 * overlapping page. Left alone the duplicate is charged twice, produces duplicate engagement rows, and —
 * because the reactions Actor rejects a `post_urls` list containing repeats — fails the whole run with a
 * 400 before a single reactor is read.
 *
 * `postUrl` is the key, because that is the field the upstream calls are keyed on. Posts with no URL fall
 * back to `postId` so they cannot collapse into each other.
 */
export function dedupePosts(posts: Post[]): Post[] {
    const seen = new Set<string>();
    return posts.filter((post) => {
        const key = post.postUrl || `id:${post.postId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export interface PageResult {
    posts: AnyPostRaw[];
    paginationToken?: string;
}

export type PageFetcher = (pageNumber: number, paginationToken?: string) => Promise<PageResult>;

export interface WindowCollectResult {
    posts: Post[];
    truncated: boolean;
    postsFetched: number;
    /** Raw records from the first non-empty page, so identity can be validated before anything is scraped. */
    firstPageRaw: AnyPostRaw[];
}

/**
 * Page backwards through a target's posts and stop at the window boundary.
 *
 * Ordering is *almost* reverse-chronological: a pinned post can sit at the top of page one while being
 * months old, and no upstream Actor exposes a pinned flag. So the boundary decision reads the **tail** of
 * each page — the oldest entry — rather than asking whether any post is out of window. An old pinned post
 * is dropped by the per-post filter and cannot terminate paging.
 */
export async function collectPostsInWindow(
    target: Target,
    fetchPage: PageFetcher,
    opts: { cutoffMs: number; maxPostsPerTarget: number },
): Promise<WindowCollectResult> {
    const kept: Post[] = [];
    let postsFetched = 0;
    let firstPageRaw: AnyPostRaw[] = [];
    let truncated = false;
    let token: string | undefined;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const result = await fetchPage(page, token);
        const batch = result.posts ?? [];
        if (!batch.length) break;

        postsFetched += batch.length;
        if (!firstPageRaw.length) firstPageRaw = batch;
        token = result.paginationToken ?? token;

        const normalized = batch.map((raw) => normalizePost(raw, target)).filter((p): p is Post => p !== null);
        const dated = normalized.filter((p) => Number.isFinite(p.postedAt));

        for (const post of dated) {
            if (post.postedAt >= opts.cutoffMs) kept.push(post);
        }

        // The last dated entry on the page is the oldest one. If it predates the cutoff, we are past the window.
        const tail = dated[dated.length - 1];
        if (tail && tail.postedAt < opts.cutoffMs) break;

        // Reached the safety cap while still inside the window: real coverage was lost.
        if (kept.length >= opts.maxPostsPerTarget) {
            truncated = true;
            break;
        }

        // A short page means the target has no more posts to give.
        if (batch.length < POSTS_PAGE_SIZE) break;

        // The profile Actor needs a token to advance; without one there is no next page to ask for.
        if (target.type === 'profile' && !token) break;
    }

    // Trimming to the cap also drops in-window posts, which is the same loss under a different name.
    if (kept.length > opts.maxPostsPerTarget) {
        kept.length = opts.maxPostsPerTarget;
        truncated = true;
    }

    return { posts: kept, truncated, postsFetched, firstPageRaw };
}
