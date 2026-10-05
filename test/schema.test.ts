import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync(new URL('../.actor/input_schema.json', import.meta.url), 'utf8')) as {
    schemaVersion: number;
    required: string[];
    properties: Record<string, Record<string, unknown>>;
};

/** Keep in step with the `Input` interface in src/types.ts and the defaults block in src/main.ts.
 *  Adding a field here on purpose means updating both. */
const EXPECTED_FIELDS = ['targets', 'postedWithin', 'maxEngagersPerPost', 'excludeJobSeekers'];

test('every input property carries title, type and description', () => {
    // The Apify input-schema validator rejects the whole Actor over a single missing description,
    // and it only says so at `apify run` time.
    for (const [name, prop] of Object.entries(schema.properties)) {
        for (const key of ['title', 'type', 'description']) {
            assert.ok(prop[key], `properties.${name}.${key} is required by the Apify input schema validator`);
        }
    }
});

test('the input schema and the Input type have not drifted apart', () => {
    assert.deepEqual(Object.keys(schema.properties).sort(), [...EXPECTED_FIELDS].sort());
});

test('only the target list is required', () => {
    assert.deepEqual(schema.required, ['targets']);
    assert.equal(schema.schemaVersion, 1);
});

test('the Actor needs no secrets', () => {
    // Judgement lives in whatever consumes the dataset, so there is no API key to configure and the
    // Actor is publishable as-is.
    const actor = JSON.parse(readFileSync(new URL('../.actor/actor.json', import.meta.url), 'utf8')) as Record<
        string,
        unknown
    >;
    assert.equal(actor.environmentVariables, undefined);
});

test('the per-post cap is bounded to the 100 the upstream Actors allow', () => {
    assert.equal(schema.properties.maxEngagersPerPost.maximum, 100);
    assert.equal(schema.properties.maxEngagersPerPost.minimum, 1);
});

test('the input surface stays small', () => {
    // v2 traded fourteen optional knobs for five inputs; a regression here means the knobs crept back.
    assert.ok(Object.keys(schema.properties).length <= 5, 'keep this Actor easy to explain');
});

test('every enum value in postedWithin is one the code knows how to resolve', () => {
    assert.deepEqual(schema.properties.postedWithin.enum, ['24h', '48h', 'week', '2weeks', 'month']);
});
