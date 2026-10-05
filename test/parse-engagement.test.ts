import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    activityId,
    excerpt,
    extractCommentRunSummary,
    normalizeComments,
    normalizeReactions,
} from '../src/parse-engagement.js';
import type { CommentRaw, Post, ReactionRaw } from '../src/types.js';

const POST: Post = {
    postId: 'urn:li:activity:7289521182721093633',
    postUrl: 'https://www.linkedin.com/posts/acme_launch-activity-7289521182721093633-abcd',
    text: 'We just shipped a new research API that pulls structured references from any public paper.',
    postedAt: Date.parse('2026-08-18T09:00:00.000Z'),
    postedAtIso: '2026-08-18T09:00:00.000Z',
    postType: 'regular',
    targetSlug: 'acme',
    targetType: 'company',
};

const author = (name: string, headline: string) => ({
    name,
    headline,
    profile_url: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\s+/g, '-')}`,
});

test('activityId pulls the numeric id out of every shape upstream uses', () => {
    assert.equal(activityId('urn:li:activity:7289521182721093633'), '7289521182721093633');
    assert.equal(
        activityId('https://www.linkedin.com/posts/x_y-activity-7289521182721093633-abcd'),
        '7289521182721093633',
    );
    assert.equal(activityId('7289521182721093633'), '7289521182721093633');
    assert.equal(activityId('nothing here'), '');
});

test('excerpt collapses whitespace and truncates at 120 characters', () => {
    assert.equal(excerpt('  hello   world  '), 'hello world');
    const long = 'x'.repeat(200);
    const out = excerpt(long);
    assert.equal(out.length, 121, '120 characters plus an ellipsis');
    assert.ok(out.endsWith('…'));
});

test("the batch Actor's summary row is never mistaken for a comment", () => {
    // This bookkeeping row carries no author. Treated as a comment it becomes a nameless lead.
    const rows: CommentRaw[] = [
        {
            comment_id: '1',
            text: 'Does it support GraphQL?',
            post_input: POST.postUrl,
            author: author('Real Person', 'CTO at Prospect Co'),
            posted_at: { timestamp: Date.parse('2026-08-18T10:00:00.000Z') },
        },
        { summary: { totalPosts: 1, successfulPosts: 1, failedPosts: 0, failedPostIds: [], commentsExtracted: 1 } },
    ];

    const engagers = normalizeComments(rows, [POST]);
    assert.equal(engagers.length, 1);
    assert.equal(engagers[0].name, 'Real Person');
});

test('nested replies become their own engagers typed as replies', () => {
    const rows: CommentRaw[] = [
        {
            comment_id: '1',
            text: 'This is great',
            post_input: POST.postUrl,
            author: author('Top Commenter', 'Head of Data at Acme Corp'),
            posted_at: { timestamp: Date.parse('2026-08-18T10:00:00.000Z') },
            replies: [
                {
                    comment_id: '2',
                    text: 'Can it export to Parquet?',
                    author: author('Nested Replier', 'Analytics Engineer at Prospect Co'),
                    posted_at: { timestamp: Date.parse('2026-08-18T11:00:00.000Z') },
                },
            ],
        },
    ];

    const engagers = normalizeComments(rows, [POST]);
    assert.equal(engagers.length, 2);
    assert.equal(engagers[0].engagementType, 'comment');
    assert.equal(engagers[1].engagementType, 'reply');
    assert.equal(engagers[1].name, 'Nested Replier');
    assert.equal(engagers[1].postUrl, POST.postUrl, "a reply inherits its parent comment's post");
});

test('comments map back to their post by activity id when the echo is not byte-identical', () => {
    const rows: CommentRaw[] = [
        {
            comment_id: '1',
            text: 'Interesting',
            post_input: '7289521182721093633', // upstream echoed the bare id, not our URL
            author: author('Id Matched', 'VP Eng at Prospect Co'),
        },
    ];
    const engagers = normalizeComments(rows, [POST]);
    assert.equal(engagers.length, 1);
    assert.equal(engagers[0].postUrl, POST.postUrl);
});

test('comments that cannot be tied to a scraped post are dropped', () => {
    const rows: CommentRaw[] = [
        { comment_id: '1', text: 'orphan', post_input: 'urn:li:activity:999', author: author('X', 'Y') },
    ];
    assert.deepEqual(normalizeComments(rows, [POST]), []);
});

test('an authorless comment is not turned into a lead', () => {
    const rows: CommentRaw[] = [{ comment_id: '1', text: 'ghost', post_input: POST.postUrl }];
    assert.deepEqual(normalizeComments(rows, [POST]), []);
});

test('the post excerpt is carried onto every engager', () => {
    const rows: CommentRaw[] = [
        { comment_id: '1', text: 'ok', post_input: POST.postUrl, author: author('A B', 'Head of X at Y') },
    ];
    assert.equal(normalizeComments(rows, [POST])[0].postExcerpt, POST.text);
});

test('extractCommentRunSummary surfaces the posts upstream failed on', () => {
    const rows: CommentRaw[] = [
        { summary: { totalPosts: 3, successfulPosts: 2, failedPosts: 1, failedPostIds: ['urn:li:activity:555'] } },
    ];
    const summary = extractCommentRunSummary(rows);
    assert.deepEqual(summary.failedPostIds, ['urn:li:activity:555']);
    assert.equal(summary.successfulPosts, 2);
});

test('reactors normalize into engagers with no comment text', () => {
    const rows: ReactionRaw[] = [
        {
            reactor: {
                name: 'Reactor One',
                headline: 'COO at Prospect Co',
                profile_url: 'https://www.linkedin.com/in/reactor-one',
            },
            reaction_type: 'LIKE',
            input: POST.postUrl,
            _metadata: { post_url: POST.postUrl, page_number: 1, total_reactions: 40 },
        },
    ];

    const engagers = normalizeReactions(rows, [POST]);
    assert.equal(engagers.length, 1);
    assert.equal(engagers[0].engagementType, 'reaction');
    assert.equal(engagers[0].commentText, null);
    assert.equal(engagers[0].postUrl, POST.postUrl);
});

test('a reaction row with no reactor is ignored', () => {
    assert.deepEqual(normalizeReactions([{ reaction_type: 'LIKE', input: POST.postUrl }], [POST]), []);
});
