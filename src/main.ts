import { Actor, log } from 'apify';

import { mapLimit } from './concurrency.js';
import { droppedReason } from './drop-rules.js';
import { buildProfileIndex, countDistinctProfiles, lookupProfile } from './employer-lookup.js';
import { CONCURRENCY, fetchComments, fetchProfiles, fetchReactions, postsFetcherFor } from './linkedin-scrapers.js';
import { dedupeEngagers } from './merge-people.js';
import { estimateCostUsd, renderStatusLine, renderSummary, sortLeads, toLeadRow } from './output.js';
import { extractCommentRunSummary, normalizeComments, normalizeReactions } from './parse-engagement.js';
import { collectPostsInWindow, dedupePosts, MAX_POSTS_PER_TARGET, resolveCutoff } from './post-window.js';
import { resolveTargets } from './target-urls.js';
import type { DroppedReason, Engager, Input, Post, RunSummary, Target } from './types.js';
import { authorMatchesTarget } from './verify-author.js';

await Actor.init();

const raw = (await Actor.getInput<Partial<Input>>()) ?? {};

const input: Input = {
    targets: raw.targets ?? [],
    postedWithin: raw.postedWithin ?? 'week',
    maxEngagersPerPost: raw.maxEngagersPerPost ?? 30,
    excludeJobSeekers: raw.excludeJobSeekers ?? true,
};

const { targets, unresolvable } = resolveTargets(input.targets);
for (const bad of unresolvable) {
    log.warning(`Could not resolve target "${bad.raw}" — expected a linkedin.com/in/… or /company/… URL.`);
}

if (!targets.length) {
    await Actor.fail('No usable targets. Give at least one linkedin.com/in/… or linkedin.com/company/… URL.');
}

const { cutoffMs, resolvedFrom, postedAfterIso } = resolveCutoff(input);
log.info(`Collecting posts published after ${postedAfterIso} for ${targets.length} target(s).`);

/* ── Stage 1: posts inside the window, validated against the target we asked for ─────────────── */

interface Collected {
    target: Target;
    posts: Post[];
    truncated: boolean;
    postsFetched: number;
    failedValidation: { requested: string; returned: string } | null;
}

const collected = await mapLimit(targets, CONCURRENCY, async (target): Promise<Collected> => {
    try {
        const result = await collectPostsInWindow(target, postsFetcherFor(target), {
            cutoffMs,
            maxPostsPerTarget: MAX_POSTS_PER_TARGET,
        });

        const identity = authorMatchesTarget(target, result.firstPageRaw);
        if (!identity.ok) {
            // A silently wrong target poisons the whole list, so nothing from it is kept.
            log.error(
                `Identity mismatch for ${target.type} "${target.slug}": upstream returned "${identity.returned}". Discarding.`,
            );
            return {
                target,
                posts: [],
                truncated: false,
                postsFetched: result.postsFetched,
                failedValidation: { requested: identity.requested, returned: identity.returned },
            };
        }

        log.info(
            `${target.type} "${target.slug}": ${result.posts.length} post(s) in window from ${result.postsFetched} fetched${
                result.truncated ? ' (TRUNCATED at cap)' : ''
            }`,
        );
        return {
            target,
            posts: result.posts,
            truncated: result.truncated,
            postsFetched: result.postsFetched,
            failedValidation: null,
        };
    } catch (err) {
        log.exception(err as Error, `Failed to fetch posts for ${target.type} "${target.slug}" — continuing.`);
        return { target, posts: [], truncated: false, postsFetched: 0, failedValidation: null };
    }
});

const postsFetched = collected.reduce((sum, c) => sum + c.postsFetched, 0);
// Targets overlap: a company page and the person who reshared its post both hand back that one post.
const pooled = collected.flatMap((c) => c.posts);
const posts = dedupePosts(pooled);
if (pooled.length !== posts.length) {
    log.info(`Collapsed ${pooled.length - posts.length} duplicate post(s) surfaced by more than one target.`);
}

/* ── Stage 2: everyone who commented or reacted ──────────────────────────────────────────────── */

let engagers: Engager[] = [];
let failedToScrape: string[] = [];
let billedEngagementRows = 0;

if (posts.length) {
    const [commentRows, reactionRows] = await Promise.all([
        fetchComments(posts, input.maxEngagersPerPost),
        fetchReactions(posts, input.maxEngagersPerPost),
    ]);

    billedEngagementRows = commentRows.length + reactionRows.length;
    failedToScrape = extractCommentRunSummary(commentRows).failedPostIds;
    engagers = [...normalizeComments(commentRows, posts), ...normalizeReactions(reactionRows, posts)];
}

const engagersRaw = engagers.length;
log.info(`${engagersRaw} engagement(s) from ${posts.length} post(s).`);

/* ── Stage 3: look up who these people actually work for ────────────────────────────────────── */

// One lookup per distinct person, not per engagement — someone reacting to three posts is one profile.
const distinctUrls = [...new Set(engagers.map((e) => e.profileUrl).filter(Boolean))];
let profileIndex = buildProfileIndex([]);

if (distinctUrls.length) {
    log.info(`Looking up ${distinctUrls.length} distinct profile(s) for real employer and title…`);
    try {
        profileIndex = buildProfileIndex(await fetchProfiles(distinctUrls));
    } catch (err) {
        // Losing enrichment costs accuracy on the employee filter, but must not lose the run.
        log.exception(err as Error, 'Profile lookup failed — continuing without verified employers.');
    }
}

const profilesResolved = countDistinctProfiles(profileIndex);

/* ── Stage 4: drop on facts only ────────────────────────────────────────────────────────────── */

const targetBySlug = new Map(targets.map((t) => [`${t.type}:${t.slug}`, t]));
const dropped: Record<string, number> = {};
const kept: Engager[] = [];

for (const engager of engagers) {
    const target = targetBySlug.get(`${engager.targetType}:${engager.targetSlug}`) ?? null;
    const reason: DroppedReason | null = droppedReason(
        engager,
        lookupProfile(profileIndex, engager.profileUrl),
        target,
        input,
    );

    if (reason) {
        dropped[reason] = (dropped[reason] ?? 0) + 1;
        continue;
    }
    kept.push(engager);
}

/* ── Stage 5: one row per person, most informative first ────────────────────────────────────── */

const scrapedAt = new Date().toISOString();
const leads = sortLeads(
    dedupeEngagers(kept).map((deduped) =>
        toLeadRow(deduped, lookupProfile(profileIndex, deduped.engager.profileUrl), scrapedAt),
    ),
);

const commenters = leads.filter((l) => l.engagementType !== 'reaction').length;

const summary: RunSummary = {
    window: { postedAfter: postedAfterIso, resolvedFrom },
    targets: {
        requested: input.targets.length,
        resolved: targets.length,
        failedValidation: collected
            .map((c) => c.failedValidation)
            .filter((f): f is NonNullable<typeof f> => f !== null),
        truncated: collected.filter((c) => c.truncated).map((c) => c.target.slug),
        unresolvable: unresolvable.map((u) => u.raw),
    },
    posts: { fetched: postsFetched, inWindow: posts.length, scraped: posts.length, failedToScrape },
    engagers: { raw: engagersRaw, unique: leads.length, dropped },
    profiles: { requested: distinctUrls.length, resolved: profilesResolved },
    people: { total: leads.length, commenters, reactorsOnly: leads.length - commenters },
    costEstimateUsd: estimateCostUsd(postsFetched, billedEngagementRows, profilesResolved),
};

if (leads.length) await Actor.pushData(leads);

await Actor.setValue('RUN_SUMMARY', summary);
log.info(`\n${renderSummary(summary)}`);
await Actor.setStatusMessage(renderStatusLine(summary));

await Actor.exit();
