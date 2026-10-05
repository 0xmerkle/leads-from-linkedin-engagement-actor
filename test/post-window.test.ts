import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTarget, isUnresolvable } from '../src/target-urls.js';
import {
    collectPostsInWindow,
    dedupePosts,
    normalizePost,
    postedAtMs,
    POSTS_PAGE_SIZE,
    resolveCutoff,
} from '../src/post-window.js';
import { postUrlsOf } from '../src/linkedin-scrapers.js';
import type { AnyPostRaw, Post, Target } from '../src/types.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-19T12:00:00.000Z');

const target = (raw = 'linkedin.com/company/acme'): Target => {
    const t = classifyTarget(raw);
    assert.ok(!isUnresolvable(t));
    return t;
};

/** A company-shaped raw post `daysAgo` days before NOW. */
const post = (daysAgo: number, id: string, text = 'hello'): AnyPostRaw => ({
    post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}`,
    activity_urn: `urn:li:activity:${id}`,
    posted_at: { timestamp: NOW - daysAgo * DAY },
    text,
});

/** `count` posts, all `daysAgo` old, with unique ids. */
const page = (count: number, daysAgo: number, prefix: string): AnyPostRaw[] =>
    Array.from({ length: count }, (_, i) => post(daysAgo, `${prefix}${String(i).padStart(3, '0')}`));

const weekAgo = () => resolveCutoff({ postedWithin: 'week' }, NOW).cutoffMs;

test('resolveCutoff: postedWithin measures back from now', () => {
    const { cutoffMs, resolvedFrom } = resolveCutoff({ postedWithin: '24h' }, NOW);
    assert.equal(cutoffMs, NOW - DAY);
    assert.equal(resolvedFrom, '24h');
    assert.equal(resolveCutoff({ postedWithin: 'week' }, NOW).cutoffMs, NOW - 7 * DAY);
    assert.equal(resolveCutoff({ postedWithin: 'month' }, NOW).cutoffMs, NOW - 30 * DAY);
});

test('resolveCutoff: postedAfter overrides postedWithin', () => {
    const { cutoffMs, resolvedFrom, postedAfterIso } = resolveCutoff(
        { postedWithin: 'month', postedAfter: '2026-08-12T00:00:00.000Z' },
        NOW,
    );
    assert.equal(cutoffMs, Date.parse('2026-08-12T00:00:00.000Z'));
    assert.equal(resolvedFrom, 'postedAfter');
    assert.equal(postedAfterIso, '2026-08-12T00:00:00.000Z');
});

test('resolveCutoff: an unparseable postedAfter falls back to the window rather than throwing', () => {
    const { cutoffMs, resolvedFrom } = resolveCutoff({ postedWithin: 'week', postedAfter: 'not a date' }, NOW);
    assert.equal(cutoffMs, NOW - 7 * DAY);
    assert.equal(resolvedFrom, 'week');
});

test('postedAtMs accepts unix seconds and unix milliseconds alike', () => {
    assert.equal(postedAtMs({ posted_at: { timestamp: 1_755_000_000_000 } }), 1_755_000_000_000);
    assert.equal(postedAtMs({ posted_at: { timestamp: 1_755_000_000 } }), 1_755_000_000_000);
    assert.equal(
        postedAtMs({ posted_at: { date: '2026-08-12T00:00:00.000Z' } }),
        Date.parse('2026-08-12T00:00:00.000Z'),
    );
    assert.equal(postedAtMs({}), null);
});

test('normalizePost reads the company shape (post_url / activity_urn)', () => {
    const p = normalizePost(post(1, '123456789012345'), target());
    assert.ok(p);
    assert.equal(p.postUrl, 'https://www.linkedin.com/feed/update/urn:li:activity:123456789012345');
    assert.equal(p.postId, 'urn:li:activity:123456789012345');
    assert.equal(p.targetType, 'company');
});

test('normalizePost reads the profile shape (url / urn.activity_urn)', () => {
    const raw: AnyPostRaw = {
        url: 'https://www.linkedin.com/posts/someone_activity-987654321098765-abcd',
        urn: { activity_urn: 'urn:li:activity:987654321098765' },
        posted_at: { timestamp: NOW },
        text: 'profile post',
    };
    const p = normalizePost(raw, target('linkedin.com/in/someone'));
    assert.ok(p);
    assert.equal(p.postUrl, 'https://www.linkedin.com/posts/someone_activity-987654321098765-abcd');
    assert.equal(p.postId, 'urn:li:activity:987654321098765');
    assert.equal(p.targetType, 'profile');
});

test('normalizePost falls back to the reshared body when a repost carries no commentary', () => {
    const raw: AnyPostRaw = {
        url: 'https://www.linkedin.com/posts/x_activity-111111111111111',
        posted_at: { timestamp: NOW },
        text: '',
        post_type: 'repost',
        reshared_post: { text: 'the original body' },
    };
    const p = normalizePost(raw, target('linkedin.com/in/x'));
    assert.equal(p?.text, 'the original body');
});

test('a page entirely inside the window fetches the next page', async () => {
    const calls: number[] = [];
    const result = await collectPostsInWindow(
        target(),
        async (pageNumber) => {
            calls.push(pageNumber);
            if (pageNumber === 1) return { posts: page(POSTS_PAGE_SIZE, 1, 'a') };
            return { posts: page(POSTS_PAGE_SIZE, 30, 'b') }; // page 2 is entirely outside
        },
        { cutoffMs: weekAgo(), maxPostsPerTarget: 300 },
    );

    assert.deepEqual(calls, [1, 2]);
    assert.equal(result.posts.length, POSTS_PAGE_SIZE, 'only the in-window page-1 posts are kept');
    assert.equal(result.truncated, false);
    assert.equal(result.postsFetched, POSTS_PAGE_SIZE * 2);
});

test('a page containing an older post keeps the in-window ones and stops', async () => {
    const calls: number[] = [];
    const mixed = [...page(POSTS_PAGE_SIZE - 1, 2, 'a'), post(20, 'old000000000001')];

    const result = await collectPostsInWindow(
        target(),
        async (pageNumber) => {
            calls.push(pageNumber);
            return { posts: mixed };
        },
        { cutoffMs: weekAgo(), maxPostsPerTarget: 300 },
    );

    assert.deepEqual(calls, [1], 'crossing the boundary stops paging immediately');
    assert.equal(result.posts.length, POSTS_PAGE_SIZE - 1, 'the in-window posts from that same page are kept');
    assert.equal(result.truncated, false);
});

test('a pinned post three months old does not terminate paging and is excluded from results', async () => {
    // No upstream Actor exposes a pinned flag, so this is handled by reading the tail of the page.
    const calls: number[] = [];
    const pinned = post(90, 'pinned000000001', 'pinned announcement');

    const result = await collectPostsInWindow(
        target(),
        async (pageNumber) => {
            calls.push(pageNumber);
            if (pageNumber === 1) return { posts: [pinned, ...page(POSTS_PAGE_SIZE - 1, 1, 'a')] };
            return { posts: page(POSTS_PAGE_SIZE, 40, 'b') };
        },
        { cutoffMs: weekAgo(), maxPostsPerTarget: 300 },
    );

    assert.deepEqual(calls, [1, 2], 'an old post pinned to the top must not end pagination');
    assert.equal(result.posts.length, POSTS_PAGE_SIZE - 1);
    assert.ok(
        !result.posts.some((p) => p.postId.includes('pinned')),
        'the pinned post is outside the window and must not appear in results',
    );
});

test('hitting maxPostsPerTarget while still inside the window sets truncated', async () => {
    const result = await collectPostsInWindow(target(), async () => ({ posts: page(POSTS_PAGE_SIZE, 1, 'a') }), {
        cutoffMs: weekAgo(),
        maxPostsPerTarget: 10,
    });

    assert.equal(result.truncated, true);
    assert.equal(result.posts.length, 10, 'the cap is honoured exactly');
});

test('exhausting the window without hitting the cap does not report truncation', async () => {
    const result = await collectPostsInWindow(
        target(),
        async () => ({ posts: [...page(3, 1, 'a'), post(20, 'old000000000002')] }),
        { cutoffMs: weekAgo(), maxPostsPerTarget: 50 },
    );

    assert.equal(result.truncated, false);
    assert.equal(result.posts.length, 3);
});

test('an empty first page ends the walk cleanly', async () => {
    const result = await collectPostsInWindow(target(), async () => ({ posts: [] }), {
        cutoffMs: weekAgo(),
        maxPostsPerTarget: 50,
    });
    assert.deepEqual(result.posts, []);
    assert.equal(result.postsFetched, 0);
    assert.equal(result.truncated, false);
});

test('a profile target stops when upstream hands back no pagination token', async () => {
    const calls: number[] = [];
    const result = await collectPostsInWindow(
        target('linkedin.com/in/someone'),
        async (pageNumber) => {
            calls.push(pageNumber);
            return { posts: page(POSTS_PAGE_SIZE, 1, 'a') }; // full page, all in window, but no token
        },
        { cutoffMs: weekAgo(), maxPostsPerTarget: 300 },
    );

    assert.deepEqual(calls, [1]);
    assert.equal(result.posts.length, POSTS_PAGE_SIZE);
});

test('a profile target follows the pagination token to the next page', async () => {
    const seen: (string | undefined)[] = [];
    await collectPostsInWindow(
        target('linkedin.com/in/someone'),
        async (pageNumber, token) => {
            seen.push(token);
            if (pageNumber === 1) {
                const posts = page(POSTS_PAGE_SIZE, 1, 'a');
                posts[0].pagination_token = 'TOKEN-2';
                return { posts, paginationToken: 'TOKEN-2' };
            }
            return { posts: page(POSTS_PAGE_SIZE, 40, 'b') };
        },
        { cutoffMs: weekAgo(), maxPostsPerTarget: 300 },
    );

    assert.deepEqual(seen, [undefined, 'TOKEN-2']);
});

/** A normalized post, as it would arrive from `normalizePost`. */
const normalized = (url: string, id = url): Post => ({
    postId: id,
    postUrl: url,
    text: '',
    postedAt: NOW,
    postedAtIso: new Date(NOW).toISOString(),
    postType: '',
    targetSlug: 'acme',
    targetType: 'company',
});

test('dedupePosts collapses one post surfaced by two targets, keeping the first', () => {
    const shared = 'https://www.linkedin.com/posts/alexagrabell_apollo-activity-1';
    const kept = dedupePosts([
        { ...normalized(shared), targetSlug: 'apolloio' },
        normalized('https://www.linkedin.com/posts/other-2'),
        { ...normalized(shared), targetSlug: 'alexagrabell' },
    ]);

    assert.deepEqual(
        kept.map((p) => p.postUrl),
        [shared, 'https://www.linkedin.com/posts/other-2'],
    );
    // First occurrence wins, so the post stays attributed to the target that surfaced it first.
    assert.equal(kept[0].targetSlug, 'apolloio');
});

test('dedupePosts keeps distinct urlless posts apart rather than collapsing them', () => {
    const kept = dedupePosts([normalized('', 'urn:a'), normalized('', 'urn:b'), normalized('', 'urn:a')]);
    assert.deepEqual(
        kept.map((p) => p.postId),
        ['urn:a', 'urn:b'],
    );
});

test('postUrlsOf sends each post once and drops empties, as the reactions Actor requires', () => {
    const dupe = 'https://www.linkedin.com/posts/dupe-1';
    assert.deepEqual(postUrlsOf([normalized(dupe), normalized(''), normalized(dupe), normalized('https://x/2')]), [
        dupe,
        'https://x/2',
    ]);
});
