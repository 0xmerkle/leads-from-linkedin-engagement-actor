import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProfileIndex, countDistinctProfiles, lookupProfile, normalizeProfile } from '../src/employer-lookup.js';
import type { ProfileRaw } from '../src/types.js';

const raw = (over: Partial<ProfileRaw['basic_info']> = {}, experience: ProfileRaw['experience'] = []): ProfileRaw => ({
    basic_info: {
        fullname: 'Test Person',
        headline: 'Doing things',
        profile_url: 'https://www.linkedin.com/in/test-person',
        ...over,
    },
    experience,
});

test('normalizeProfile reads the explicit current-company fields', () => {
    const p = normalizeProfile(
        raw({
            current_company: 'Apollo.io',
            current_company_url: 'https://www.linkedin.com/company/apolloio',
            open_to_work: false,
        }),
    );
    assert.equal(p?.currentCompany, 'Apollo.io');
    assert.equal(p?.currentCompanySlug, 'apolloio');
    assert.equal(p?.openToWork, false);
});

test('normalizeProfile falls back to the experience entry flagged current', () => {
    const p = normalizeProfile(
        raw({}, [
            {
                company: 'Old Corp',
                company_linkedin_url: 'https://www.linkedin.com/company/old-corp',
                title: 'Intern',
                is_current: false,
            },
            {
                company: 'Apollo.io',
                company_linkedin_url: 'https://www.linkedin.com/company/apolloio',
                title: 'Senior Marketer',
                is_current: true,
            },
        ]),
    );
    assert.equal(p?.currentCompanySlug, 'apolloio');
    assert.equal(p?.currentTitle, 'Senior Marketer');
});

test('normalizeProfile returns null when there is no profile URL to key on', () => {
    assert.equal(normalizeProfile({ basic_info: { fullname: 'Nobody' } }), null);
});

test('buildProfileIndex keys on every URL spelling upstream might echo', () => {
    const index = buildProfileIndex([
        {
            basic_info: { profile_url: 'https://www.linkedin.com/in/test-person', current_company: 'Acme' },
            profileUrl: 'linkedin.com/in/test-person/',
            profile_input: 'https://www.linkedin.com/in/test-person',
        },
    ]);
    assert.ok(lookupProfile(index, 'https://www.linkedin.com/in/test-person'));
    assert.ok(lookupProfile(index, 'linkedin.com/in/test-person'));
    assert.ok(lookupProfile(index, 'https://www.linkedin.com/in/test-person/'));
    assert.equal(lookupProfile(index, 'https://www.linkedin.com/in/someone-else'), null);
});

test('buildProfileIndex skips records with nothing usable in them', () => {
    assert.equal(buildProfileIndex([{ message: 'not found' }]).size, 0);
    assert.equal(buildProfileIndex([]).size, 0);
});

test('countDistinctProfiles counts people, not index keys', () => {
    // The index stores each profile under several URL spellings, so index.size is a key count. Using it
    // as a person count once reported "579 of 385 resolved" and overstated a run's cost.
    // `profile_input` echoes whatever was sent, which may be a bare username rather than a URL — that
    // normalizes to a different key than the full URL, so one person can occupy several index slots.
    const index = buildProfileIndex([
        {
            basic_info: { profile_url: 'https://www.linkedin.com/in/a', current_company: 'Acme' },
            profileUrl: 'linkedin.com/in/a/',
            profile_input: 'a',
        },
        {
            basic_info: { profile_url: 'https://www.linkedin.com/in/b', current_company: 'Beta' },
            profileUrl: 'linkedin.com/in/b/',
            profile_input: 'b',
        },
    ]);
    assert.ok(index.size > 2, 'the index really does hold more keys than people');
    assert.equal(countDistinctProfiles(index), 2);
    assert.equal(countDistinctProfiles(new Map()), 0);
});
