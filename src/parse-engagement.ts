import type { CommentRaw, Engager, Post, ReactionRaw } from './types.js';

export const EXCERPT_CHARS = 120;

export function excerpt(text: string | null | undefined, chars = EXCERPT_CHARS): string {
    const t = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    return t.length <= chars ? t : `${t.slice(0, chars).trimEnd()}…`;
}

function toIso(posted: { timestamp?: number; date?: string } | undefined): string | null {
    const ts = posted?.timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
        return new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
    }
    if (posted?.date) {
        const parsed = Date.parse(posted.date);
        if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
    return null;
}

/** Pull the numeric activity id out of any of the shapes LinkedIn and the upstream Actors use for it. */
export function activityId(value: string | null | undefined): string {
    const s = String(value ?? '');
    const m = /(?:activity[:-]|ugcPost[:-]|share[:-])(\d{6,})/i.exec(s) ?? /(\d{15,})/.exec(s);
    return m ? m[1] : '';
}

/**
 * Index the posts we scraped so an engager can be mapped back to one.
 * Upstream echoes our input back in different fields per Actor (`post_input`, `input`, `_metadata.post_url`),
 * and not always byte-identical, so index by activity id as well as by the raw string.
 */
export function buildPostIndex(posts: Post[]): Map<string, Post> {
    const index = new Map<string, Post>();
    for (const post of posts) {
        if (post.postUrl) index.set(post.postUrl, post);
        const id = activityId(post.postId) || activityId(post.postUrl);
        if (id) index.set(id, post);
        if (post.postId) index.set(post.postId, post);
    }
    return index;
}

function lookupPost(index: Map<string, Post>, ...candidates: (string | null | undefined)[]): Post | null {
    for (const candidate of candidates) {
        if (!candidate) continue;
        const direct = index.get(candidate);
        if (direct) return direct;
        const id = activityId(candidate);
        if (id) {
            const byId = index.get(id);
            if (byId) return byId;
        }
    }
    return null;
}

function engagerFrom(
    post: Post,
    author: { name?: string; headline?: string; profile_url?: string } | undefined,
    fields: Pick<Engager, 'engagementType' | 'commentText' | 'commentedAt'>,
): Engager {
    return {
        name: String(author?.name ?? '').trim(),
        headline: String(author?.headline ?? '').trim(),
        profileUrl: String(author?.profile_url ?? '').trim(),
        ...fields,
        postUrl: post.postUrl,
        postId: post.postId,
        postExcerpt: excerpt(post.text),
        targetSlug: post.targetSlug,
        targetType: post.targetType,
    };
}

/**
 * Flatten comment records into engagers.
 *
 * Two things this has to get right. Replies arrive **nested** under `replies[]` rather than linked by a
 * parent id, so `reply` is derived from position, not from a field. And the batch Actor appends one
 * bookkeeping row carrying only a `summary` object — treat that as a comment and it becomes a nameless lead.
 */
export function normalizeComments(rows: CommentRaw[], posts: Post[]): Engager[] {
    const index = buildPostIndex(posts);
    const out: Engager[] = [];

    for (const row of rows ?? []) {
        if (!row || row.summary) continue;

        const post = lookupPost(index, row.post_input, row.comment_url);
        if (!post) continue;

        if (row.author?.profile_url || row.author?.name) {
            out.push(
                engagerFrom(post, row.author, {
                    engagementType: 'comment',
                    commentText: String(row.text ?? '').trim() || null,
                    commentedAt: toIso(row.posted_at),
                }),
            );
        }

        for (const reply of row.replies ?? []) {
            if (!reply || (!reply.author?.profile_url && !reply.author?.name)) continue;
            out.push(
                engagerFrom(post, reply.author, {
                    engagementType: 'reply',
                    commentText: String(reply.text ?? '').trim() || null,
                    commentedAt: toIso(reply.posted_at),
                }),
            );
        }
    }

    return out;
}

/** The comments Actor's bookkeeping row is the only place failed posts are reported. */
export function extractCommentRunSummary(rows: CommentRaw[]): { failedPostIds: string[]; successfulPosts: number } {
    const failedPostIds: string[] = [];
    let successfulPosts = 0;

    for (const row of rows ?? []) {
        if (!row?.summary) continue;
        successfulPosts += row.summary.successfulPosts ?? 0;
        for (const id of row.summary.failedPostIds ?? []) {
            const s = String(id ?? '').trim();
            if (s) failedPostIds.push(s);
        }
    }

    return { failedPostIds, successfulPosts };
}

/** Reactors carry no text, so every one of these is tiered T4 downstream. */
export function normalizeReactions(rows: ReactionRaw[], posts: Post[]): Engager[] {
    const index = buildPostIndex(posts);
    const out: Engager[] = [];

    for (const row of rows ?? []) {
        if (!row?.reactor) continue;
        // eslint-disable-next-line no-underscore-dangle -- `_metadata` is the upstream Actor's field name.
        const post = lookupPost(index, row._metadata?.post_url, row.input);
        if (!post) continue;
        if (!row.reactor.profile_url && !row.reactor.name) continue;

        out.push(
            engagerFrom(post, row.reactor, {
                engagementType: 'reaction',
                commentText: null,
                commentedAt: null,
            }),
        );
    }

    return out;
}
