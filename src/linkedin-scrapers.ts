import { Actor, log } from 'apify';

import { chunk, mapLimit } from './concurrency.js';
import { type PageResult, POSTS_PAGE_SIZE } from './post-window.js';
import type { AnyPostRaw, CommentRaw, Post, ProfileRaw, ReactionRaw, Target } from './types.js';

/** All four are apimaestro, no-cookies, and billed per result at $0.005. */
export const ACTORS = {
    companyPosts: 'apimaestro/linkedin-company-posts',
    profilePosts: 'apimaestro/linkedin-profile-posts',
    comments: 'apimaestro/linkedin-post-comments-replies-engagements-scraper-no-cookies',
    reactions: 'apimaestro/linkedin-post-reactions',
    profiles: 'apimaestro/linkedin-profile-batch-scraper-no-cookies-required',
} as const;

export const PRICE_PER_RESULT_USD = 0.005;

/** Posts per batched engagement call. Upstream allows more, but a smaller batch fails smaller. */
export const ENGAGEMENT_BATCH = 50;

/** Concurrent upstream runs. */
export const CONCURRENCY = 4;

/** Items per dataset read. A single unbounded read can exceed the API's response size cap, which would
 *  silently return a partial page — a 50-post comment batch can be well over a thousand rows. */
const READ_PAGE = 500;

async function callAndRead<T>(actorId: string, input: Record<string, unknown>): Promise<T[]> {
    const run = await Actor.call(actorId, input);
    if (!run?.defaultDatasetId) {
        log.warning(`${actorId} returned no dataset`, { status: run?.status });
        return [];
    }

    const dataset = await Actor.openDataset(run.defaultDatasetId, { forceCloud: true });
    const out: T[] = [];

    for (let offset = 0; ; offset += READ_PAGE) {
        const { items } = await dataset.getData({ offset, limit: READ_PAGE });
        out.push(...(items as T[]));
        if (items.length < READ_PAGE) break;
    }

    return out;
}

/** Company posts. `sort: 'recent'` is pinned explicitly — `top` would destroy the date ordering the
 *  window paging depends on, and it would do so silently. */
export function companyPostsFetcher(target: Target) {
    return async (pageNumber: number): Promise<PageResult> => {
        const posts = await callAndRead<AnyPostRaw>(ACTORS.companyPosts, {
            company_name: target.canonicalUrl,
            page_number: pageNumber,
            limit: POSTS_PAGE_SIZE,
            sort: 'recent',
        });
        return { posts };
    };
}

/** Profile posts. Page 2 onwards requires the pagination token handed back by the previous page.
 *  `total_posts` is deliberately unused: it takes over pagination and would defeat stop-at-boundary. */
export function profilePostsFetcher(target: Target) {
    return async (pageNumber: number, paginationToken?: string): Promise<PageResult> => {
        const input: Record<string, unknown> = {
            username: target.canonicalUrl,
            page_number: pageNumber,
            limit: POSTS_PAGE_SIZE,
        };
        if (paginationToken) input.pagination_token = paginationToken;

        const posts = await callAndRead<AnyPostRaw>(ACTORS.profilePosts, input);
        const nextToken = posts.find((p) => p.pagination_token)?.pagination_token;
        return { posts, paginationToken: nextToken };
    };
}

export function postsFetcherFor(target: Target) {
    return target.type === 'company' ? companyPostsFetcher(target) : profilePostsFetcher(target);
}

/**
 * Post URLs to send upstream: non-empty, and each one only once.
 *
 * The reactions Actor rejects a `post_urls` array containing repeats outright — a 400 that kills the run
 * before any reactor is read — so uniqueness here is a hard requirement of the upstream contract, not a
 * tidiness measure. Callers pool posts from several targets, and one post reaches this function twice
 * whenever two targets surface it.
 */
export function postUrlsOf(posts: Post[]): string[] {
    return [...new Set(posts.map((p) => p.postUrl).filter(Boolean))];
}

/** One batched call per chunk of posts. Returns comments with their replies nested, plus a summary row. */
export async function fetchComments(posts: Post[], maxCommentsPerPost: number): Promise<CommentRaw[]> {
    const batches = chunk(postUrlsOf(posts), ENGAGEMENT_BATCH);
    if (!batches.length) return [];

    const results = await mapLimit(batches, CONCURRENCY, async (postIds, i) => {
        log.info(`Fetching comments for batch ${i + 1}/${batches.length} (${postIds.length} posts)`);
        return callAndRead<CommentRaw>(ACTORS.comments, {
            postIds,
            page_number: 1,
            sortOrder: 'most recent',
            limit: Math.min(100, Math.max(1, maxCommentsPerPost)),
        });
    });

    return results.flat();
}

/**
 * Reactors come from a separate Actor. The comments Actor returns reaction *counts* per comment
 * (`stats.reactions`), never reactor identities, so this call is the only source of who reacted.
 */
export async function fetchReactions(posts: Post[], maxReactionsPerPost: number): Promise<ReactionRaw[]> {
    const batches = chunk(postUrlsOf(posts), ENGAGEMENT_BATCH);
    if (!batches.length) return [];

    const results = await mapLimit(batches, CONCURRENCY, async (postUrls, i) => {
        log.info(`Fetching reactions for batch ${i + 1}/${batches.length} (${postUrls.length} posts)`);
        return callAndRead<ReactionRaw>(ACTORS.reactions, {
            post_urls: postUrls,
            page_number: 1,
            reaction_type: 'ALL',
            limit: Math.min(100, Math.max(1, maxReactionsPerPost)),
        });
    });

    return results.flat();
}

/**
 * Fetch full profiles for a set of people.
 *
 * `includeEmail` stays off. This Actor's job ends at a qualified LinkedIn profile; turning those into
 * addresses is a separate waterfall through dedicated contact-data tools, and doing it here would mean
 * collecting personal contact data on everyone who merely engaged with a post.
 */
export async function fetchProfiles(profileUrls: string[]): Promise<ProfileRaw[]> {
    const unique = [...new Set((profileUrls ?? []).map((u) => String(u ?? '').trim()).filter(Boolean))];
    const batches = chunk(unique, ENGAGEMENT_BATCH);
    if (!batches.length) return [];

    const results = await mapLimit(batches, CONCURRENCY, async (usernames, i) => {
        log.info(`Enriching profile batch ${i + 1}/${batches.length} (${usernames.length} people)`);
        return callAndRead<ProfileRaw>(ACTORS.profiles, { usernames, includeEmail: false });
    });

    return results.flat();
}
