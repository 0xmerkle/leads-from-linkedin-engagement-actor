import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTarget, isUnresolvable, normalizeTargetUrl, resolveTargets } from '../src/target-urls.js';
import { authorMatchesTarget, normalizeCompanyName, normalizeNameForMatch } from '../src/verify-author.js';
import type { AnyPostRaw, Target } from '../src/types.js';

const asTarget = (raw: string): Target => {
    const t = classifyTarget(raw);
    assert.ok(!isUnresolvable(t), `expected ${raw} to resolve`);
    return t;
};

test('normalizeTargetUrl strips protocol, www, locale, query, fragment and trailing slash', () => {
    assert.equal(normalizeTargetUrl('https://www.linkedin.com/company/foo/'), 'linkedin.com/company/foo');
    assert.equal(normalizeTargetUrl('HTTP://LinkedIn.com/company/Foo'), 'linkedin.com/company/foo');
    assert.equal(normalizeTargetUrl('de.linkedin.com/company/foo?originalSubdomain=de'), 'linkedin.com/company/foo');
    assert.equal(normalizeTargetUrl('linkedin.com/company/foo#about'), 'linkedin.com/company/foo');
    assert.equal(normalizeTargetUrl(''), '');
});

test('classifyTarget: company URL forms', () => {
    assert.deepEqual(
        { type: asTarget('linkedin.com/company/foo').type, slug: asTarget('linkedin.com/company/foo').slug },
        { type: 'company', slug: 'foo' },
    );
    assert.equal(asTarget('https://www.linkedin.com/company/foo/').slug, 'foo');
    assert.equal(asTarget('https://www.linkedin.com/company/foo/posts/?locale=de').slug, 'foo');
    assert.equal(asTarget('https://www.linkedin.com/company/foo/posts/?locale=de').type, 'company');
});

test('classifyTarget: profile URL', () => {
    const t = asTarget('linkedin.com/in/bar');
    assert.equal(t.type, 'profile');
    assert.equal(t.slug, 'bar');
    assert.equal(t.canonicalUrl, 'https://www.linkedin.com/in/bar');
});

test('classifyTarget: school pages behave like company pages but keep their path', () => {
    const t = asTarget('linkedin.com/school/baz');
    assert.equal(t.type, 'company');
    assert.equal(t.slug, 'baz');
    assert.equal(t.kind, 'school');
    assert.equal(t.canonicalUrl, 'https://www.linkedin.com/school/baz');
});

test('classifyTarget: explicit prefix forms are honoured directly', () => {
    assert.equal(asTarget('company:foo').type, 'company');
    assert.equal(asTarget('company:foo').slug, 'foo');
    assert.equal(asTarget('profile:bar').type, 'profile');
    assert.equal(asTarget('profile:bar').slug, 'bar');
});

test('classifyTarget: a bare token is unresolvable rather than guessed at', () => {
    const t = classifyTarget('foo');
    assert.ok(isUnresolvable(t));
    assert.equal(t.reason, 'unresolvable_target');
    assert.ok(isUnresolvable(classifyTarget('some company name')));
});

test('resolveTargets dedupes two spellings of one target down to one', () => {
    const { targets, unresolvable } = resolveTargets([
        'https://www.linkedin.com/company/foo/',
        'linkedin.com/company/foo',
        'LINKEDIN.COM/company/foo/posts/',
    ]);
    assert.equal(targets.length, 1);
    assert.equal(unresolvable.length, 0);
});

test('resolveTargets keeps a company and a profile with the same slug apart', () => {
    const { targets } = resolveTargets(['linkedin.com/company/foo', 'linkedin.com/in/foo']);
    assert.equal(targets.length, 2);
});

test('resolveTargets collects unresolvable inputs without dropping the good ones', () => {
    const { targets, unresolvable } = resolveTargets(['linkedin.com/company/foo', 'heyreach', '']);
    assert.equal(targets.length, 1);
    assert.equal(unresolvable.length, 1);
    assert.equal(unresolvable[0].raw, 'heyreach');
});

test('normalizeNameForMatch collapses case and punctuation', () => {
    assert.equal(normalizeNameForMatch('Grow With Clay'), 'growwithclay');
    assert.equal(normalizeNameForMatch('grow-with-clay'), 'growwithclay');
    assert.equal(normalizeNameForMatch('Apollo.io'), 'apolloio');
});

test('normalizeCompanyName drops noise tokens whole, never as substrings', () => {
    assert.equal(normalizeCompanyName('Acme Inc.'), 'acme');
    assert.equal(normalizeCompanyName('Retool'), 'retool', 'must not strip "io" out of the middle of a word');
    assert.equal(normalizeCompanyName('Sanofi'), 'sanofi', 'must not strip a trailing "ai"-like fragment');
});

test('authorMatchesTarget accepts a company whose display name matches the slug', () => {
    const target = asTarget('linkedin.com/company/grow-with-clay');
    const posts: AnyPostRaw[] = [{ author: { name: 'Grow With Clay' }, post_url: 'x' }];
    assert.deepEqual(authorMatchesTarget(target, posts), { ok: true });
});

test('authorMatchesTarget accepts a company that brands itself with part of its slug', () => {
    const target = asTarget('linkedin.com/company/grow-with-clay');
    const posts: AnyPostRaw[] = [{ author: { name: 'Clay' }, post_url: 'x' }];
    assert.deepEqual(authorMatchesTarget(target, posts), { ok: true });
});

test('authorMatchesTarget accepts a company_url that matches the requested slug', () => {
    const target = asTarget('linkedin.com/company/apolloio');
    const posts: AnyPostRaw[] = [
        { author: { name: 'Apollo.io', company_url: 'https://www.linkedin.com/company/apolloio' }, post_url: 'x' },
    ];
    assert.deepEqual(authorMatchesTarget(target, posts), { ok: true });
});

test('authorMatchesTarget REJECTS a stranger returned for a valid-looking slug', () => {
    // The failure that motivates this whole function: `heyreach` returned an unrelated person's post.
    const target = asTarget('linkedin.com/in/heyreach');
    const posts: AnyPostRaw[] = [{ author: { name: 'Pritesh Rajput' }, url: 'x' }];
    const result = authorMatchesTarget(target, posts);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.requested === 'heyreach');
    assert.ok(!result.ok && result.returned === 'Pritesh Rajput');
});

test('authorMatchesTarget uses the profile username when upstream provides one', () => {
    const target = asTarget('linkedin.com/in/satyanadella');
    assert.deepEqual(
        authorMatchesTarget(target, [{ author: { name: 'Satya Nadella', username: 'satyanadella' }, url: 'x' }]),
        { ok: true },
    );
});

test('authorMatchesTarget does not invent a failure when there is nothing to compare', () => {
    const target = asTarget('linkedin.com/company/foo');
    assert.deepEqual(authorMatchesTarget(target, []), { ok: true });
    assert.deepEqual(authorMatchesTarget(target, [{ post_url: 'x' }]), { ok: true });
});
