import { normalizeTargetUrl } from './target-urls.js';
import type { EnrichedProfile, ProfileRaw } from './types.js';

function companySlugFrom(url: string | null | undefined): string {
    const m = /linkedin\.com\/(?:[a-z]{2}\/)?(?:company|school)\/([^/?#]+)/.exec(normalizeTargetUrl(url ?? ''));
    return m ? m[1] : '';
}

function profileKey(url: string | null | undefined): string {
    return normalizeTargetUrl(url ?? '');
}

/** Flatten a profile record, preferring the explicit current-company fields and falling back to
 *  whichever experience entry is flagged current. */
export function normalizeProfile(raw: ProfileRaw): EnrichedProfile | null {
    const basic = raw.basic_info ?? {};
    const current = (raw.experience ?? []).find((e) => e.is_current);

    const profileUrl = basic.profile_url ?? raw.profileUrl ?? raw.profile_input ?? '';
    if (!profileUrl) return null;

    const currentCompanyUrl = basic.current_company_url ?? current?.company_linkedin_url ?? '';

    return {
        profileUrl,
        currentCompany: (basic.current_company ?? current?.company ?? '').trim(),
        currentCompanySlug: companySlugFrom(currentCompanyUrl),
        currentCompanyUrl,
        currentTitle: (current?.title ?? '').trim(),
        openToWork: basic.open_to_work === true,
        headline: (basic.headline ?? '').trim(),
        about: (basic.about ?? '').trim(),
    };
}

/** Index by every spelling of the profile URL upstream might echo, so lookups do not miss. */
export function buildProfileIndex(raws: ProfileRaw[]): Map<string, EnrichedProfile> {
    const index = new Map<string, EnrichedProfile>();

    for (const raw of raws ?? []) {
        const profile = normalizeProfile(raw);
        if (!profile) continue;
        for (const candidate of [profile.profileUrl, raw.profileUrl, raw.profile_input]) {
            const key = profileKey(candidate);
            if (key) index.set(key, profile);
        }
    }

    return index;
}

export function lookupProfile(index: Map<string, EnrichedProfile>, profileUrl: string): EnrichedProfile | null {
    return index.get(profileKey(profileUrl)) ?? null;
}

/**
 * How many distinct people the index holds.
 *
 * `buildProfileIndex` deliberately stores each profile under several URL spellings so lookups never
 * miss, which means `index.size` is a count of keys, not of people. Using it as a person count once
 * reported "579 of 385 profiles resolved" and overstated a run's cost by about a dollar.
 */
export function countDistinctProfiles(index: Map<string, EnrichedProfile>): number {
    return new Set([...index.values()].map((p) => p.profileUrl)).size;
}
