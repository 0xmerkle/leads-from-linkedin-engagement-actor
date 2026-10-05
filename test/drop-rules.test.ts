import { test } from 'node:test';
import assert from 'node:assert/strict';

import { droppedReason, hasNoIdentity, isCompanyPage } from '../src/drop-rules.js';
import { dedupeEngagers, engagementWeight } from '../src/merge-people.js';
import type { EnrichedProfile, Engager } from '../src/types.js';

const opts = { excludeJobSeekers: true };
const companyTarget = (slug: string) => ({ slug, type: 'company' as const });

const engager = (over: Partial<Engager> = {}): Engager => ({
    name: 'Someone',
    headline: 'Head of Ops at Acme',
    profileUrl: 'https://www.linkedin.com/in/someone',
    engagementType: 'comment',
    commentText: 'interesting',
    commentedAt: null,
    postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1',
    postId: 'urn:li:activity:1',
    postExcerpt: 'excerpt',
    targetSlug: 'apolloio',
    targetType: 'company',
    ...over,
});

const profile = (over: Partial<EnrichedProfile> = {}): EnrichedProfile => ({
    profileUrl: 'https://www.linkedin.com/in/someone',
    currentCompany: 'Northwind Logistics',
    currentCompanySlug: 'northwind-logistics',
    currentCompanyUrl: 'https://www.linkedin.com/company/northwind-logistics',
    currentTitle: 'Head of RevOps',
    openToWork: false,
    headline: 'Head of RevOps',
    about: '',
    ...over,
});

test('a company page is detected by its URL or its follower-count headline', () => {
    assert.ok(isCompanyPage({ headline: 'anything', profileUrl: 'https://www.linkedin.com/company/acme' }));
    assert.ok(isCompanyPage({ headline: 'anything', profileUrl: 'https://www.linkedin.com/school/mit' }));
    assert.ok(isCompanyPage({ headline: '154,012 followers', profileUrl: '' }));
    assert.equal(isCompanyPage({ headline: 'Head of Ops', profileUrl: 'https://www.linkedin.com/in/x' }), false);
});

test('an engager with no usable identity is detected', () => {
    assert.ok(hasNoIdentity({ headline: 'anything', profileUrl: '' }));
    assert.ok(hasNoIdentity({ headline: '--', profileUrl: 'https://www.linkedin.com/in/x' }));
    assert.equal(hasNoIdentity({ headline: 'Head of Ops', profileUrl: 'https://www.linkedin.com/in/x' }), false);
});

test('THE POINT OF ENRICHMENT: a staffer whose headline never names the employer is caught', () => {
    // "AI GTM Loop Maxxing Engineer" names no company, so no headline rule could ever catch it —
    // and neither could a model, which reads the same text. The employer's own URL can.
    const e = engager({ headline: 'AI GTM Loop Maxxing Engineer 🥷🏼' });
    const p = profile({ currentCompany: 'Apollo.io', currentCompanySlug: 'apolloio' });
    assert.equal(droppedReason(e, p, companyTarget('apolloio'), opts), 'target_employee');
});

test('the employer match is exact, not fuzzy', () => {
    // The fuzzy matching this replaced flagged "Barclays" for a target called `clay`.
    const p = profile({ currentCompanySlug: 'apollo-global-management', currentCompany: 'Apollo Global Management' });
    assert.equal(droppedReason(engager(), p, companyTarget('apolloio'), opts), null);
    assert.equal(
        droppedReason(engager(), profile({ currentCompanySlug: 'barclays' }), companyTarget('clay'), opts),
        null,
    );
});

test("LinkedIn's open-to-work flag replaces guessing from a headline", () => {
    const p = profile({ openToWork: true, headline: 'Senior Data Engineer' });
    assert.equal(droppedReason(engager(), p, companyTarget('apolloio'), opts), 'job_seeker');
    assert.equal(droppedReason(engager(), p, companyTarget('apolloio'), { excludeJobSeekers: false }), null);
});

test('for a profile target, the author replying under their own post is dropped', () => {
    const author = engager({ profileUrl: 'https://www.linkedin.com/in/some-operator', targetType: 'profile' });
    const other = engager({ profileUrl: 'https://www.linkedin.com/in/a-prospect', targetType: 'profile' });
    const target = { slug: 'some-operator', type: 'profile' as const };
    assert.equal(droppedReason(author, profile(), target, opts), 'target_employee');
    assert.equal(droppedReason(other, profile(), target, opts), null);
});

test('a genuine prospect survives', () => {
    assert.equal(droppedReason(engager(), profile(), companyTarget('apolloio'), opts), null);
});

test('missing enrichment fails open rather than dropping the person', () => {
    // Dropping on absent data would silently delete good leads, which is worse than a leak.
    assert.equal(droppedReason(engager(), null, companyTarget('apolloio'), opts), null);
});

test('structural checks run before enrichment is consulted', () => {
    const page = engager({ profileUrl: 'https://www.linkedin.com/company/apolloio', headline: '154,012 followers' });
    assert.equal(droppedReason(page, null, companyTarget('apolloio'), opts), 'company_page');
});

test('dedupe accumulates counts and keeps the most informative engagement', () => {
    const url = 'https://www.linkedin.com/in/repeat';
    const engagers: Engager[] = [
        engager({ profileUrl: url, engagementType: 'reaction', commentText: null, postUrl: 'p1', targetSlug: 'a' }),
        engager({
            profileUrl: url,
            engagementType: 'comment',
            commentText: 'Does it support SSO?',
            postUrl: 'p2',
            targetSlug: 'b',
        }),
        engager({
            profileUrl: `${url}/`,
            engagementType: 'reply',
            commentText: 'thanks',
            postUrl: 'p3',
            targetSlug: 'a',
        }),
    ];

    const leads = dedupeEngagers(engagers);
    assert.equal(leads.length, 1, 'a trailing slash is the same person');

    const [lead] = leads;
    assert.equal(lead.timesSeen, 3);
    assert.equal(lead.engager.engagementType, 'comment', 'a comment beats a reply beats a reaction');
    assert.equal(lead.engager.commentText, 'Does it support SSO?');
    assert.deepEqual(lead.postsEngaged, ['p1', 'p2', 'p3']);
    assert.deepEqual(lead.targetsEngaged, ['a', 'b']);
});

test('dedupe keeps distinct people apart', () => {
    const engagers = [
        engager({ profileUrl: 'https://www.linkedin.com/in/a' }),
        engager({ profileUrl: 'https://www.linkedin.com/in/b' }),
    ];
    assert.equal(dedupeEngagers(engagers).length, 2);
});

test('engagementWeight ranks a comment above a reply above a reaction', () => {
    assert.ok(engagementWeight('comment') < engagementWeight('reply'));
    assert.ok(engagementWeight('reply') < engagementWeight('reaction'));
});
