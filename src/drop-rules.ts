import { normalizeTargetUrl } from './target-urls.js';
import type { DroppedReason, Engager, EnrichedProfile, Target } from './types.js';

/** A page's "headline" is just its follower count. */
const FOLLOWER_ONLY = /^[\d.,\s]+\s*followers?$/i;

/**
 * Is this engager a LinkedIn page rather than a person?
 *
 * Two facts, no guessing: the profile URL points at /company/ or /school/, or the headline is nothing
 * but a follower count. Both are structural, which is why this survived the move to ground-truth
 * filtering while the headline keyword matching did not.
 */
export function isCompanyPage(engager: Pick<Engager, 'headline' | 'profileUrl'>): boolean {
    const url = normalizeTargetUrl(engager.profileUrl ?? '');
    if (/linkedin\.com\/(?:[a-z]{2}\/)?(?:company|school)\//.test(url)) return true;
    return FOLLOWER_ONLY.test(String(engager.headline ?? '').trim());
}

export function hasNoIdentity(engager: Pick<Engager, 'headline' | 'profileUrl'>): boolean {
    if (!String(engager.profileUrl ?? '').trim()) return true;
    const h = String(engager.headline ?? '').trim();
    return !h || h === '--' || h === '-';
}

function companySlugOf(url: string | null | undefined): string {
    const m = /linkedin\.com\/(?:[a-z]{2}\/)?(?:company|school)\/([^/?#]+)/.exec(normalizeTargetUrl(url ?? ''));
    return m ? m[1] : '';
}

function profileSlugOf(url: string | null | undefined): string {
    const m = /linkedin\.com\/(?:[a-z]{2}\/)?in\/([^/?#]+)/.exec(normalizeTargetUrl(url ?? ''));
    return m ? m[1] : '';
}

/**
 * Should this person be dropped before they are ever scored?
 *
 * Every check here is a fact rather than an inference — a URL shape, an exact slug comparison against
 * the employer's own LinkedIn page, or LinkedIn's own open-to-work boolean. The fuzzy headline matching
 * this replaced produced a steady stream of false positives ("Barclays" for a target called `clay`) and
 * false negatives (any headline that simply never named an employer).
 *
 * Anything requiring judgement — competitor, wrong-fit, recruiter — is left to ICP scoring.
 */
export function droppedReason(
    engager: Pick<Engager, 'headline' | 'profileUrl'>,
    profile: EnrichedProfile | null,
    target: Pick<Target, 'slug' | 'type'> | null,
    opts: { excludeJobSeekers: boolean },
): DroppedReason | null {
    if (isCompanyPage(engager)) return 'company_page';
    if (hasNoIdentity(engager)) return 'no_identity';

    // The target themselves, replying under their own post.
    if (target?.type === 'profile' && profileSlugOf(engager.profileUrl) === target.slug) return 'target_employee';

    if (profile) {
        // Exact match against the employer's own company page — the entire point of enriching everyone.
        if (target?.type === 'company' && profile.currentCompanySlug) {
            if (profile.currentCompanySlug === target.slug.toLowerCase()) return 'target_employee';
        }
        if (opts.excludeJobSeekers && profile.openToWork) return 'job_seeker';
    }

    return null;
}

export { companySlugOf, profileSlugOf };
