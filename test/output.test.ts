import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { DedupedEngager } from '../src/merge-people.js';
import { estimateCostUsd, leadId, renderStatusLine, renderSummary, sortLeads, toLeadRow } from '../src/output.js';
import type { EnrichedProfile, Engager, Lead, RunSummary } from '../src/types.js';

const engager = (over: Partial<Engager> = {}): Engager => ({
    name: 'Someone',
    headline: 'building things',
    profileUrl: 'https://www.linkedin.com/in/someone',
    engagementType: 'comment',
    commentText: 'hi',
    commentedAt: null,
    postUrl: 'p',
    postId: 'i',
    postExcerpt: 'e',
    targetSlug: 'acme',
    targetType: 'company',
    ...over,
});

const deduped = (over: Partial<DedupedEngager> = {}): DedupedEngager => ({
    engager: engager(),
    timesSeen: 1,
    postsEngaged: [],
    targetsEngaged: [],
    ...over,
});

const profile = (over: Partial<EnrichedProfile> = {}): EnrichedProfile => ({
    profileUrl: 'https://www.linkedin.com/in/someone',
    currentCompany: 'Northwind Logistics',
    currentCompanySlug: 'northwind-logistics',
    currentCompanyUrl: 'https://www.linkedin.com/company/northwind-logistics',
    currentTitle: 'VP Revenue Operations',
    openToWork: false,
    headline: 'RevOps lead',
    about: '',
    ...over,
});

const lead = (over: Partial<Lead>): Lead =>
    ({
        leadId: 'x',
        name: 'Someone',
        headline: 'h',
        profileUrl: 'https://www.linkedin.com/in/someone',
        currentCompany: 'Northwind',
        currentTitle: 'VP RevOps',
        enriched: true,
        engagementType: 'comment',
        commentText: 'hi',
        commentedAt: null,
        timesSeen: 1,
        postsEngaged: [],
        targetsEngaged: [],
        postUrl: 'p',
        postExcerpt: 'e',
        targetSlug: 'acme',
        targetType: 'company',
        scrapedAt: '2026-08-21T12:00:00.000Z',
        ...over,
    }) as Lead;

test('leadId is stable across cosmetic URL differences', () => {
    assert.equal(leadId('https://www.linkedin.com/in/someone'), leadId('linkedin.com/in/someone/'));
    assert.notEqual(leadId('https://www.linkedin.com/in/a'), leadId('https://www.linkedin.com/in/b'));
});

test('a row carries the verified employer, not the self-written headline', () => {
    const row = toLeadRow(
        deduped({ timesSeen: 4, postsEngaged: ['p1', 'p2'], targetsEngaged: ['acme', 'other'] }),
        profile(),
        '2026-08-21T12:00:00.000Z',
    );
    assert.equal(row.currentTitle, 'VP Revenue Operations');
    assert.equal(row.currentCompany, 'Northwind Logistics');
    assert.equal(row.enriched, true);
    assert.equal(row.headline, 'building things', 'the headline is kept for context, not for judging');
    assert.equal(row.timesSeen, 4);
    assert.deepEqual(row.targetsEngaged, ['acme', 'other']);
});

test('an unresolved profile is flagged rather than dropped or guessed at', () => {
    const row = toLeadRow(deduped(), null, '2026-08-21T12:00:00.000Z');
    assert.equal(row.enriched, false);
    assert.equal(row.currentCompany, '');
    assert.equal(row.currentTitle, '');
    assert.ok(row.name, 'the person still makes it into the output');
});

test('a profile that resolved but told us no employer is NOT counted as enriched', () => {
    // Three rows in a live run came back resolved with an empty employer. Reporting those as enriched
    // invites a reader to trust a row we know nothing verifiable about.
    const employerless = toLeadRow(deduped(), profile({ currentCompany: '', currentTitle: '' }), 's');
    assert.equal(employerless.enriched, false);

    assert.equal(toLeadRow(deduped(), profile({ currentTitle: '' }), 's').enriched, true, 'a company alone is enough');
    assert.equal(toLeadRow(deduped(), profile({ currentCompany: '' }), 's').enriched, true, 'a title alone is enough');
});

test('people whose words you can read come first', () => {
    // The Actor cannot rank by fit — it has no ICP. It can put the informative rows on top so the
    // output is not arbitrary before something else ranks it.
    const rows = [
        lead({ name: 'reactor', engagementType: 'reaction', commentText: null, timesSeen: 9 }),
        lead({ name: 'replier', engagementType: 'reply', timesSeen: 1 }),
        lead({ name: 'commenter', engagementType: 'comment', timesSeen: 1 }),
    ];
    assert.deepEqual(
        sortLeads(rows).map((r) => r.name),
        ['commenter', 'replier', 'reactor'],
    );
});

test('within the same kind of engagement, frequency wins', () => {
    const rows = [
        lead({ name: 'once', timesSeen: 1 }),
        lead({ name: 'thrice', timesSeen: 3 }),
        lead({ name: 'twice', timesSeen: 2 }),
    ];
    assert.deepEqual(
        sortLeads(rows).map((r) => r.name),
        ['thrice', 'twice', 'once'],
    );
});

test('cost counts posts, engagement rows and profile lookups alike', () => {
    // v1 omitted profiles and under-reported a live run by $0.22.
    assert.equal(estimateCostUsd(75, 61, 44), 0.9);
    assert.equal(estimateCostUsd(0, 0, 0), 0);
});

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
    window: { postedAfter: '2026-08-14T00:00:00.000Z', resolvedFrom: 'week' },
    targets: { requested: 3, resolved: 3, failedValidation: [], truncated: [], unresolvable: [] },
    posts: { fetched: 75, inWindow: 9, scraped: 9, failedToScrape: [] },
    engagers: { raw: 468, unique: 299, dropped: { company_page: 36, target_employee: 67 } },
    profiles: { requested: 385, resolved: 380 },
    people: { total: 299, commenters: 120, reactorsOnly: 179 },
    costEstimateUsd: 4.41,
    ...over,
});

test('the funnel reports every silent drop', () => {
    const text = renderSummary(
        summary({
            targets: {
                requested: 4,
                resolved: 3,
                failedValidation: [{ requested: 'heyreach', returned: 'Pritesh Rajput' }],
                truncated: ['fivosaresti'],
                unresolvable: ['just-a-name'],
            },
            posts: { fetched: 75, inWindow: 9, scraped: 9, failedToScrape: ['urn:li:activity:1'] },
        }),
    );

    assert.match(text, /FAILED VALIDATION/);
    assert.match(text, /heyreach → returned "Pritesh Rajput"/);
    assert.match(text, /TRUNCATED at the post cap: fivosaresti/);
    assert.match(text, /unresolvable: just-a-name/);
    assert.match(text, /upstream failed on 1 post/);
    assert.match(text, /dropped target_employee: 67/);
    assert.match(text, /380\/385/);
    assert.match(text, /120 wrote something, 179 only reacted/);
});

test('a clean run reports no warnings it did not earn', () => {
    const text = renderSummary(summary());
    assert.doesNotMatch(text, /FAILED VALIDATION/);
    assert.doesNotMatch(text, /TRUNCATED/);
    assert.match(text, /299 distinct/);
});

test('the status line leads with people and comments', () => {
    assert.match(renderStatusLine(summary()), /^299 people \(120 with a comment\)/);
    const warned = renderStatusLine(
        summary({
            targets: {
                requested: 4,
                resolved: 3,
                failedValidation: [{ requested: 'a', returned: 'b' }],
                truncated: ['c'],
                unresolvable: [],
            },
        }),
    );
    assert.match(warned, /1 failed validation, 1 truncated/);
});

test('the dataset view shows the verified employer and what people said', () => {
    const schema = JSON.parse(readFileSync(new URL('../.actor/dataset_schema.json', import.meta.url), 'utf8')) as {
        views: Record<string, { transformation: { fields: string[] } }>;
    };
    const fields = schema.views.overview.transformation.fields;
    for (const f of ['currentTitle', 'currentCompany', 'commentText', 'enriched']) {
        assert.ok(fields.includes(f), `${f} belongs in the default view`);
    }
});
