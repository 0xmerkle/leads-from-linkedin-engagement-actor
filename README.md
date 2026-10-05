## What does LinkedIn Engagement Leads do?

**It turns the people who engage with LinkedIn posts into a ranked list of prospects.** Give it a handful of [LinkedIn](https://www.linkedin.com) profiles or company pages and a plain-English description of who you sell to. It pulls each target's recent posts, collects everyone who commented or reacted, looks up **who each of those people actually works for**, and scores them 0–100 against your ideal customer profile.

The output is one row per person, best fit first, with their real job title, their real employer, and — where they wrote something — the sentence that makes them worth contacting.

The point is that it scores people on **facts, not self-description**. A LinkedIn headline is marketing copy; "AI GTM Loop Maxxing Engineer" tells you nothing. Every person found here is looked up in full, so the ranking uses the employer's own LinkedIn page and the person's real current title.

It runs on the Apify platform, so you get API access, [scheduling](https://docs.apify.com/platform/schedule), webhooks and monitoring for free. It is **stateless** — you give it a window, it returns that window's people.

## Why use LinkedIn Engagement Leads?

Someone who engages with your competitor's post is paying attention to your category right now. This finds those people and tells you which ones can actually buy.

- **Competitor engagement mining.** Point it at competitors' pages and the operators in your space.
- **Ranked by fit, not by noise.** A well-matched VP who clicked "like" outranks a poor-fit junior who wrote three paragraphs.
- **Competitors flagged, not hidden.** People who work for companies competing with you are scored 0 and labelled `competitor`, so they never reach your outreach list by accident.
- **Real hooks where they exist.** Commenters arrive with their own words attached, which is the difference between a cold email and a relevant one.
- **Five inputs.** Two of them required.

## How to use LinkedIn Engagement Leads

1. Click **Try for free**.
2. Paste your targets into **Target LinkedIn URLs** — personal profiles, company pages, or both.
3. Describe who you sell to in **Who do you sell to?**. Be specific, and name your competitors — this text is what every score is measured against.
4. Add your OpenAI API key as an Actor secret named `openaiApiKey` (see below).
5. Click **Start**. Read the funnel in the log, and open **Storage** for your list.

**Target personal profiles, not just company pages.** On live runs, personal profiles produced every actionable lead and company pages produced none — a company page's engagement is mostly its own staff and its competitors. Company pages are still useful for finding _competitors' customers_; just expect the good rows to come from people.

### The API key

Scoring uses a small OpenAI model, so a key is required:

```
apify secrets add openaiApiKey sk-your-key-here
```

Locally, export `OPENAI_API_KEY` instead. Set `OPENAI_MODEL` to override the default `gpt-5-nano`.

## Input

```json
{
    "targets": ["https://www.linkedin.com/in/some-operator", "https://www.linkedin.com/company/a-competitor"],
    "icpDescription": "We sell a data-enrichment API to RevOps and growth leaders at B2B SaaS companies between 50 and 500 employees. Competitors include Clay, Apollo and ZoomInfo.",
    "postedWithin": "week",
    "maxEngagersPerPost": 30,
    "excludeJobSeekers": true
}
```

### Targets

A profile (`linkedin.com/in/<slug>`), a company page (`linkedin.com/company/<slug>`), or a school page (which behaves like a company). The explicit `profile:<slug>` / `company:<slug>` form works too. A bare name with no path is **rejected rather than guessed at** and reported as `unresolvable_target`.

### The ICP description

This is the most important field. It is read by the scoring model alongside each person's real title and employer, and it decides every `icpFit` and `icpVerdict`. Name the roles you sell to, the kind of company they work at, and your competitors. Vague input produces vague rankings.

### The time window

No upstream LinkedIn Actor supports date filtering, so recency is handled here: the Actor pages backwards through each target's posts and stops as soon as it crosses your boundary. It never walks a back catalogue.

### Volume and cost

`maxEngagersPerPost` applies separately to commenters and reactors, so `30` means up to 30 of each per post. Reactors outnumber commenters by a wide margin on most posts, so this is the main lever on both volume and spend.

## Output

One row per person, best fit first. Download as JSON, HTML, CSV or Excel.

```json
{
    "leadId": "a3f1c9d02b8e4471",
    "name": "Jordan Ellis",
    "headline": "building things in public 🚀",
    "profileUrl": "https://www.linkedin.com/in/jordan-ellis",
    "currentCompany": "Northwind Logistics",
    "currentTitle": "VP Revenue Operations",
    "icpFit": 88,
    "icpVerdict": "buyer",
    "intentTier": "T2_self_disclosure",
    "whyNow": "They name the handoff between tools as the real cost, which an integrated flow removes.",
    "engagementType": "comment",
    "commentText": "The real cost of running 5 to 7 tools isn't the tool spend; it's the handoff between them.",
    "commentedAt": "2026-08-18T14:22:03.000Z",
    "timesSeen": 3,
    "targetsEngaged": ["some-operator", "a-competitor"],
    "postsEngaged": ["https://www.linkedin.com/posts/…"],
    "postUrl": "https://www.linkedin.com/posts/…",
    "postExcerpt": "The four roles every modern GTM team needs…",
    "targetSlug": "some-operator",
    "targetType": "profile",
    "scrapedAt": "2026-08-19T12:00:00.000Z"
}
```

### Output fields

| Field                                      | Description                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `icpFit`                                   | 0–100 against your ICP description. **The primary sort key.**            |
| `icpVerdict`                               | `buyer`, `practitioner`, `competitor`, `employee` or `irrelevant`.       |
| `currentTitle` / `currentCompany`          | From their profile — not from the headline they wrote.                   |
| `intentTier`                               | What their engagement revealed. Breaks ties at equal fit.                |
| `whyNow`                                   | One line on why they are worth contacting. Only ever set for `T1`/`T2`.  |
| `name` / `headline` / `profileUrl`         | Identity. `profileUrl` is the dedupe key.                                |
| `engagementType`                           | `comment`, `reply` or `reaction`.                                        |
| `commentText` / `commentedAt`              | What they wrote, if anything. Null for reactors.                         |
| `timesSeen`                                | How many separate engagements this person made across the run.           |
| `targetsEngaged`                           | Distinct targets they engaged with. More than one is a strong signal.    |
| `postsEngaged` / `postUrl` / `postExcerpt` | What they engaged with.                                                  |
| `leadId`                                   | Stable hash of the normalized profile URL. Use it to dedupe across runs. |

### Intent tiers

Fit ranks the person; intent ranks what they did.

| Tier                 | Meaning                                          | Example                                                                    |
| -------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| `T1_question`        | Asking about the product — actively evaluating   | _"Is there a self-hosted option, and how does pricing work for 40 seats?"_ |
| `T2_self_disclosure` | Describing their own workflow or pain            | _"I've been doing this by hand in a spreadsheet every month."_             |
| `T3_praise`          | Generic approval, banter, or industry commentary | _"Congrats!"_, _"Great thread"_                                            |
| `T4_reaction`        | Reacted, wrote nothing                           | —                                                                          |

Precedence is strict: a comment that both asks about the product and describes a workflow is `T1`. A reply aimed at _another commenter_ rather than the poster is demoted out of the high tiers, because thread banter routinely carries a question mark without being about the product.

**Fit is sorted ahead of intent on purpose.** For a cold-email list the person matters more than the gesture — and on a reaction-heavy run every row is `T4`, so intent-first sorting would carry no information at all.

### The run summary

Every run writes `RUN_SUMMARY` to the key-value store, logs it as a funnel, and puts a one-line version in the status message. Every silent drop is reported: targets that failed identity validation, targets truncated at the post cap, posts upstream failed on, and every person dropped with the reason.

```
Window:    posts after 2026-08-14T12:49:02.475Z (from "week")
Targets:   3 resolved of 3 requested
           TRUNCATED at the post cap: fivosaresti
Posts:     75 fetched → 7 in window → 7 scraped
Engagers:  74 engagements → 34 distinct people
           dropped company_page: 10
           dropped target_employee: 11
Profiles:  38/44 enriched with real employer and title
Scoring:   gpt-5-nano scored 41 people against your ICP
           buyer 11, practitioner 7, competitor 6, irrelevant 17
Leads:     34 — 9 scoring 70+, 0 asked a question, 11 described their own workflow
Cost:      ~$0.90 of upstream Actor usage
```

## How much does it cost?

This Actor charges nothing itself. It pays upstream Actors that each bill **$5.00 per 1,000 results**, so your cost is roughly:

```
(posts fetched + people found + profiles enriched) × $0.005
```

Three targets on a one-week window at `maxEngagersPerPost: 30` runs about **$2.60**. Scoring is billed separately by OpenAI and is negligible — on `gpt-5-nano` a run of this size is around **$0.01**, so it is not included in `costEstimateUsd`.

Ways to spend less:

- **Lower `maxEngagersPerPost`.** Reactors are the bulk of the volume and the lowest signal per person.
- **Use a tighter window.** A 24-hour window on a daily schedule costs a fraction of a monthly one.
- **Fewer, better targets.** Personal profiles of operators in your space beat a long list of company pages.

## Tips

- **Name your competitors in the ICP description.** They are scored 0 and labelled `competitor`. On a live run this caught five competitor founders that a hand-written blocklist had missed.
- **Filter on `icpVerdict != competitor` before outreach.** Competitors stay in the dataset deliberately — a model verdict shouldn't silently delete rows — but they are not leads.
- **Watch `timesSeen` and `targetsEngaged`.** Someone appearing under two different targets is paying real attention to your category.
- **Schedule with overlap.** A weekly schedule on a `2weeks` window costs more but survives a failed run. Deduplicate downstream on `leadId`.

## Known limitations

- **Volume is modest.** A few targets on a weekly window yields tens of people, not thousands. This is a signal tool, not a firehose.
- **Enrichment does not always resolve.** Some profiles come back empty; those people are kept and scored on their headline alone rather than dropped, because dropping on missing data would quietly delete good prospects. The summary reports the resolved ratio.
- **Scoring is not reproducible.** The same input can produce slightly different scores run to run. `scripts/calibrate.mts` exists for exactly this reason — it scores a fixed set of known cases so you can check the model is still discriminating.
- **`T1_question` is rare on personal profiles.** A product question needs a product to ask about. Opinion posts generate `T2` instead; judge those runs on `T2` and fit.
- **A reaction is weak evidence.** It means attention, not interest. Reactors are ranked on fit alone, which is why the real title and employer matter so much here.
- **Reposts are attributed to the reposter.** When a target reshares someone else's post, the engagement collected is engagement on that reshare.

## FAQ

**Does this need my LinkedIn cookies or login?** No. Every upstream Actor is cookie-free and reads only publicly visible data.

**Is scraping LinkedIn legal?** This collects only public posts, comments, reactions and profile data any logged-out visitor can see. It does not access private profiles or bypass authentication. You are responsible for how you use the output, including your obligations under GDPR and other data-protection law when you contact people. Take legal advice if you are unsure.

**Why are there no email addresses?** Contact enrichment is deliberately out of scope. This stops at a ranked list of people and why they are worth contacting.

**Why did I get so few leads?** Read the funnel. Usually the window is too narrow, the targets did not post, or the targets' engagement really is mostly their own employees.

## Support

Found a person the scoring gets wrong? Open an issue on the **Issues** tab with the run ID and the row — mis-scored leads are the most useful bug report for this Actor.
