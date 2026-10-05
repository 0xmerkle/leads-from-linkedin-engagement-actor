import { createHash } from 'node:crypto';

import { PRICE_PER_RESULT_USD } from './linkedin-scrapers.js';
import { type DedupedEngager, engagementWeight, leadKey } from './merge-people.js';
import type { EnrichedProfile, Lead, RunSummary } from './types.js';

export function leadId(profileUrl: string): string {
    return createHash('sha1').update(leadKey(profileUrl)).digest('hex').slice(0, 16);
}

export function toLeadRow(deduped: DedupedEngager, profile: EnrichedProfile | null, scrapedAt: string): Lead {
    const { engager } = deduped;
    return {
        leadId: leadId(engager.profileUrl),
        name: engager.name,
        headline: engager.headline,
        profileUrl: engager.profileUrl,
        currentCompany: profile?.currentCompany ?? '',
        currentTitle: profile?.currentTitle ?? '',
        // "We know where they work", not merely "the lookup returned something" — three rows in a live
        // run came back resolved but employerless, and a reader would over-trust them.
        enriched: Boolean(profile && (profile.currentCompany || profile.currentTitle)),
        engagementType: engager.engagementType,
        commentText: engager.commentText,
        commentedAt: engager.commentedAt,
        timesSeen: deduped.timesSeen,
        postsEngaged: deduped.postsEngaged,
        targetsEngaged: deduped.targetsEngaged,
        postUrl: engager.postUrl,
        postExcerpt: engager.postExcerpt,
        targetSlug: engager.targetSlug,
        targetType: engager.targetType,
        scrapedAt,
    };
}

/**
 * People whose own words you can read, first.
 *
 * This Actor deliberately does not rank by fit — that needs an ideal customer profile, which it does not
 * have. What it can do is put the rows carrying the most information at the top, so the output is never
 * arbitrary before something else ranks it properly.
 */
export function sortLeads(rows: Lead[]): Lead[] {
    return [...rows].sort((a, b) => {
        const bySignal = engagementWeight(a.engagementType) - engagementWeight(b.engagementType);
        if (bySignal !== 0) return bySignal;
        if (b.timesSeen !== a.timesSeen) return b.timesSeen - a.timesSeen;
        return (a.name || '').localeCompare(b.name || '');
    });
}

/** Every upstream result is billed identically, so the estimate is a count of everything we asked for. */
export function estimateCostUsd(postsFetched: number, engagementRows: number, profilesFetched: number): number {
    return Number(((postsFetched + engagementRows + profilesFetched) * PRICE_PER_RESULT_USD).toFixed(2));
}

/** The funnel, rendered for the log. Every silent drop upstream gets a line here. */
export function renderSummary(summary: RunSummary): string {
    const { targets, posts, engagers, profiles, people } = summary;
    const lines = [
        `Window:    posts after ${summary.window.postedAfter} (from "${summary.window.resolvedFrom}")`,
        `Targets:   ${targets.resolved} resolved of ${targets.requested} requested`,
    ];

    if (targets.unresolvable.length) lines.push(`           unresolvable: ${targets.unresolvable.join(', ')}`);
    if (targets.failedValidation.length) {
        const detail = targets.failedValidation.map((f) => `${f.requested} → returned "${f.returned}"`).join('; ');
        lines.push(`           FAILED VALIDATION (discarded): ${detail}`);
    }
    if (targets.truncated.length) lines.push(`           TRUNCATED at the post cap: ${targets.truncated.join(', ')}`);

    lines.push(`Posts:     ${posts.fetched} fetched → ${posts.inWindow} in window → ${posts.scraped} scraped`);
    if (posts.failedToScrape.length) {
        lines.push(`           upstream failed on ${posts.failedToScrape.length} post(s)`);
    }

    lines.push(`Engagers:  ${engagers.raw} engagements → ${engagers.unique} distinct people`);
    for (const [reason, count] of Object.entries(engagers.dropped)) {
        if (count > 0) lines.push(`           dropped ${reason}: ${count}`);
    }

    lines.push(`Profiles:  ${profiles.resolved}/${profiles.requested} enriched with real employer and title`);

    lines.push(
        `People:    ${people.total} distinct — ${people.commenters} wrote something, ${people.reactorsOnly} only reacted`,
    );
    lines.push(`Cost:      ~$${summary.costEstimateUsd.toFixed(2)} of upstream Actor usage`);

    return lines.join('\n');
}

/** One line, for the run's status message. */
export function renderStatusLine(summary: RunSummary): string {
    const warnings: string[] = [];
    if (summary.targets.failedValidation.length) {
        warnings.push(`${summary.targets.failedValidation.length} failed validation`);
    }
    if (summary.targets.truncated.length) warnings.push(`${summary.targets.truncated.length} truncated`);

    const base =
        `${summary.people.total} people (${summary.people.commenters} with a comment) ` +
        `from ${summary.posts.scraped} posts across ${summary.targets.resolved} targets — ` +
        `~$${summary.costEstimateUsd.toFixed(2)}`;

    return warnings.length ? `${base} — ${warnings.join(', ')}` : base;
}
