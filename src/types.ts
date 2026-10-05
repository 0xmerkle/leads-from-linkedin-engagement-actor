/** Shared types: our own domain model plus the shapes the upstream apimaestro Actors actually return. */

export type TargetType = 'company' | 'profile';

/** The LinkedIn path kind the target was written as. School pages route like companies but must keep their path. */
export type UrlKind = 'company' | 'school' | 'in';

export interface Input {
    targets: string[];
    postedWithin: '24h' | '48h' | 'week' | '2weeks' | 'month';
    /** Cap applied separately to comments and to reactions, per post. */
    maxEngagersPerPost: number;
    excludeJobSeekers: boolean;
}

export interface Target {
    type: TargetType;
    slug: string;
    kind: UrlKind;
    /** Rebuilt clean URL, used when calling upstream so a /school/ target keeps its path. */
    canonicalUrl: string;
    /** The input string this target was resolved from, kept for error reporting. */
    raw: string;
}

export interface UnresolvableTarget {
    raw: string;
    reason: 'unresolvable_target';
}

/** A post normalized across the two very different posts Actors. */
export interface Post {
    postId: string;
    postUrl: string;
    text: string;
    /** Unix milliseconds. */
    postedAt: number;
    postedAtIso: string;
    postType: string;
    targetSlug: string;
    targetType: TargetType;
}

export type EngagementType = 'comment' | 'reply' | 'reaction';

export interface Engager {
    name: string;
    headline: string;
    profileUrl: string;
    engagementType: EngagementType;
    commentText: string | null;
    commentedAt: string | null;
    postUrl: string;
    postId: string;
    postExcerpt: string;
    targetSlug: string;
    targetType: TargetType;
}

/** Why someone was dropped. All three are facts, not guesses: a URL shape, an exact company match,
 *  or LinkedIn's own open-to-work flag. */
export type DroppedReason = 'company_page' | 'no_identity' | 'target_employee' | 'job_seeker';

export interface Lead {
    leadId: string;
    name: string;
    /** The headline the person wrote about themselves. Kept for context, not for judging them. */
    headline: string;
    profileUrl: string;
    /** From their profile. Empty when the lookup did not resolve. */
    currentCompany: string;
    currentTitle: string;
    /** True only when we actually learned an employer or title. False means judge them at your own risk. */
    enriched: boolean;
    engagementType: EngagementType;
    commentText: string | null;
    commentedAt: string | null;
    timesSeen: number;
    postsEngaged: string[];
    targetsEngaged: string[];
    postUrl: string;
    postExcerpt: string;
    targetSlug: string;
    targetType: TargetType;
    scrapedAt: string;
}

export interface RunSummary {
    window: { postedAfter: string; resolvedFrom: string };
    targets: {
        requested: number;
        resolved: number;
        failedValidation: { requested: string; returned: string }[];
        truncated: string[];
        unresolvable: string[];
    };
    posts: { fetched: number; inWindow: number; scraped: number; failedToScrape: string[] };
    engagers: { raw: number; unique: number; dropped: Record<string, number> };
    profiles: { requested: number; resolved: number };
    people: { total: number; commenters: number; reactorsOnly: number };
    costEstimateUsd: number;
}

/* ── Upstream response shapes ─────────────────────────────────────────────────
 * Verified against the inferred output schemas of the five apimaestro Actors.
 * The two posts Actors disagree about nearly every field name, hence the split.
 */

export interface UpstreamPostedAt {
    timestamp?: number;
    date?: string;
    relative?: string;
    is_edited?: boolean;
}

/** apimaestro/linkedin-company-posts. Note: post_url, activity_urn, no author.headline/username. */
export interface CompanyPostRaw {
    posted_at?: UpstreamPostedAt;
    post_url?: string;
    activity_urn?: string;
    full_urn?: string;
    text?: string;
    post_type?: string;
    source_company?: string;
    author?: { name?: string; company_url?: string; follower_count?: number };
}

/** apimaestro/linkedin-profile-posts. Note: url (not post_url), urn.activity_urn, reshared_post. */
export interface ProfilePostRaw {
    posted_at?: UpstreamPostedAt;
    url?: string;
    urn?: { activity_urn?: string; ugcPost_urn?: string | null; share_urn?: string | null };
    full_urn?: string;
    text?: string;
    post_type?: string;
    pagination_token?: string;
    profile_input?: string;
    author?: { name?: string; headline?: string; username?: string; profile_url?: string; actor_type?: string };
    reshared_post?: { text?: string; author?: { name?: string; profile_url?: string } };
}

export type AnyPostRaw = CompanyPostRaw & ProfilePostRaw;

export interface UpstreamAuthor {
    name?: string;
    headline?: string;
    profile_id?: string;
    profile_url?: string;
}

/** apimaestro/linkedin-post-comments-...-no-cookies. Replies are NESTED, not linked by id. */
export interface CommentRaw {
    comment_id?: string;
    comment_url?: string;
    text?: string;
    post_input?: string;
    author?: UpstreamAuthor;
    posted_at?: UpstreamPostedAt;
    replies?: CommentRaw[];
    /** The batch Actor appends one bookkeeping row shaped like this. Never a comment. */
    summary?: {
        totalPosts?: number;
        successfulPosts?: number;
        failedPosts?: number;
        failedPostIds?: unknown[];
        commentsExtracted?: number;
        page_number?: number;
    };
}

/** apimaestro/linkedin-post-reactions. The only Actor that returns reactor identities. */
export interface ReactionRaw {
    reactor?: { name?: string; headline?: string; profile_url?: string; urn?: string | null };
    reaction_type?: string;
    input?: string;
    _metadata?: { page_number?: number; total_reactions?: number; post_url?: string };
}

/**
 * apimaestro/linkedin-profile-batch-scraper-no-cookies-required.
 * The only source of a person's *actual* employer — every other Actor only offers a self-written headline.
 */
export interface ProfileRaw {
    profileUrl?: string;
    profile_input?: string;
    message?: string;
    basic_info?: {
        fullname?: string;
        headline?: string;
        about?: string;
        current_company?: string;
        current_company_url?: string;
        open_to_work?: boolean;
        profile_url?: string;
        public_identifier?: string;
    };
    experience?: {
        company?: string;
        company_linkedin_url?: string;
        title?: string;
        is_current?: boolean;
    }[];
}

/** A profile flattened to the handful of facts that matter. */
export interface EnrichedProfile {
    profileUrl: string;
    currentCompany: string;
    /** Slug out of the company's LinkedIn URL. This is the field that makes the employee check exact. */
    currentCompanySlug: string;
    currentCompanyUrl: string;
    currentTitle: string;
    openToWork: boolean;
    headline: string;
    about: string;
}
