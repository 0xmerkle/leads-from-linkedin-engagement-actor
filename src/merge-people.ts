import { normalizeTargetUrl } from './target-urls.js';
import type { EngagementType, Engager } from './types.js';

export function leadKey(profileUrl: string): string {
    return normalizeTargetUrl(profileUrl);
}

/**
 * How much a single engagement tells you about a person, cheapest signal last.
 *
 * A comment carries their own words, which is the thing worth reading; a reaction carries only the fact
 * that they looked. Nothing here judges *what* was said — that needs a reader, and this Actor has none.
 */
const ENGAGEMENT_WEIGHT: Record<EngagementType, number> = { comment: 0, reply: 1, reaction: 2 };

export function engagementWeight(type: EngagementType): number {
    return ENGAGEMENT_WEIGHT[type] ?? 3;
}

export interface DedupedEngager {
    engager: Engager;
    timesSeen: number;
    postsEngaged: string[];
    targetsEngaged: string[];
}

/**
 * Collapse repeat engagements by the same person into one record, accumulating rather than discarding.
 * Someone who turns up under three different targets is a far stronger signal than a single reactor,
 * and their highest-intent engagement becomes the record you act on.
 *
 * Cross-run dedupe is deliberately not done here — that belongs to whatever consumes the dataset.
 */
export function dedupeEngagers(engagers: Engager[]): DedupedEngager[] {
    const byKey = new Map<string, DedupedEngager>();

    for (const engager of engagers) {
        const key = leadKey(engager.profileUrl);
        const existing = byKey.get(key);

        if (!existing) {
            byKey.set(key, {
                engager,
                timesSeen: 1,
                postsEngaged: engager.postUrl ? [engager.postUrl] : [],
                targetsEngaged: engager.targetSlug ? [engager.targetSlug] : [],
            });
            continue;
        }

        existing.timesSeen += 1;
        if (engager.postUrl && !existing.postsEngaged.includes(engager.postUrl)) {
            existing.postsEngaged.push(engager.postUrl);
        }
        if (engager.targetSlug && !existing.targetsEngaged.includes(engager.targetSlug)) {
            existing.targetsEngaged.push(engager.targetSlug);
        }
        // Keep the most informative thing this person did: a comment beats a reply beats a reaction.
        if (engagementWeight(engager.engagementType) < engagementWeight(existing.engager.engagementType)) {
            existing.engager = engager;
        }
    }

    return [...byKey.values()];
}
