# Google access kit: Business Profile API and OAuth verification

The owner's step-by-step for getting the Google Business Profile (GBP)
connector out of the dark ([`google.md`](google.md)): getting eligible
through a partner business, applying for Basic API Access (#44), switching
the connector on, and taking the OAuth consent screen to production.
It complements [`launch.md` §4](launch.md#4-google) (the checklist) and
[`infra/provisioning.md`](../infra/provisioning.md#google-oauth-client-and-business-profile-api-access-m3-444546)
(the OAuth client and secrets).

Every Google requirement below was checked against Google's own pages on
**2026-10-07**; each section cites them with the page's "last updated" date
where it shows one. Where Google's documentation and what developers report
disagree, both are given, and the report is labelled as such. Re-check the
cited pages before you submit anything; they change.

**Read [Risks to settle before applying](#risks-to-settle-before-applying)
first.** Two of them (review storage, and reports that the v4 reviews
endpoint is unavailable to newly approved projects) could change whether
the connector as built is worth the application.

| Step | Who | Lead time |
|---|---|---|
| [1. Eligibility through a partner business](#1-eligibility-through-a-partner-business) | partner + owner | a day, once the partner agrees |
| [2. Apply for Basic API Access](#2-apply-for-basic-api-access) | owner | 30 min, then 1–6 weeks |
| [3. After approval: quota, APIs, switch on](#3-after-approval-quota-apis-and-the-switch) | owner | 30 min |
| [4. OAuth consent screen to production](#4-oauth-consent-screen-production-readiness) | owner (+ counsel for §4.7) | 1–2 h, then 3–5 business days |
| [5. The 100-user cap and living with it](#5-the-100-user-cap-and-working-within-it) | owner | — |

## Risks to settle before applying

1. **Content storage policy.** Google's
   [Business Profile APIs policies](https://developers.google.com/my-business/content/policies)
   (last updated 2026-08-28), "Content storage": *"You cannot pre-fetch,
   cache, index, or store any content provided through the Business Profile
   APIs ("Content") for use outside of your Business Profile project except
   for limited amounts of Content"*, and stored Content *"must be stored
   temporarily for no more than 30 calendar days"* and *"cannot be
   manipulated or aggregated in any way."* ProofQL stores connector reviews
   until deleted, splits them into excerpts and embeds them. Whether
   displaying a business's reviews on its own site through ProofQL is use
   *inside* "your Business Profile project" (the app that holds the API
   access) is a reading for the owner and counsel. [`places.md`](places.md#terms-and-attribution)
   currently says the connector's data "carries no such limit"; that is not
   what this policy says on its face. If the conservative reading wins, the
   cheap mitigation mirrors the Places refresh: re-list every enabled
   location in full at least every 30 days (⌈reviews ÷ 50⌉ calls per
   location, well inside 300 QPM) and delete rows Google no longer returns.
   **Decide before applying**, because the application describes what we
   do with the data.
2. **The v4 reviews endpoint.** Reviews are only on the legacy My Business
   v4 API ([`accounts.locations.reviews.list`](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list),
   page updated 2026-04-07, no deprecation notice; the
   [deprecation schedule](https://developers.google.com/my-business/content/sunset-dates),
   updated 2026-08-28, lists none for reviews). **Reported, not confirmed
   by Google:** in a Google Developer forum thread from 2026-08-12 to
   2026-10-02, eight developers say `mybusiness.googleapis.com` cannot be
   enabled ("not available to this consumer") even after Basic Access was
   approved, and two say a previously working v4 reviews call now returns
   `404 Method not found`
   ([thread](https://discuss.google.dev/t/business-profile-api-reviews-endpoint-mybusiness-googleapis-com-cant-be-enabled-basic-access-pending-10-business-days/389462);
   no Google staff reply as of 2026-10-07). If approval does not unlock v4,
   the connector has nothing to poll. Apply anyway (it costs nothing), but
   do not plan the launch around the connector until §3's check passes.
3. **"Programmatic access" by third parties.** The same policies forbid
   letting third parties reach the GBP APIs "through automatic or
   programmatic computer scripts" via your own API. ProofQL's customers
   never trigger a Google call (the pipeline polls on its own schedule,
   only for connections a person made by signing in), but its query and
   reviews API do serve the stored reviews programmatically. This is our
   reading that it is allowed, not Google's; it is one more reason the
   application must describe the product plainly.
4. **Whether `business.manage` is sensitive.** See
   [§4.1](#41-sensitive-or-restricted). The Google pages checked here do not label it;
   developers report the Cloud console showing it as non-sensitive while
   external users are still blocked. Prepare the full sensitive-scope
   package regardless; it is a superset.
5. **Reviewer consent for display.** Google's brand guidance for
   businesses ([Partner Marketing Hub, "Customer reviews"](https://partnermarketinghub.withgoogle.com/brands/google/use-cases/customer-reviews/),
   no date shown, checked 2026-10-07) says *"User reviews belong to the
   person who wrote them, even if they're written on your business's
   listing. You must get consent from the reviewer if you want to use
   customer reviews of your business for your own marketing purposes, such
   as on your website"*. This is guidance, not an API term, and it applies
   to every import path (Places, CSV, the connector) — but a reviewer who
   knows it may ask about the product's premise. The Terms already put
   the right to display on the customer ("Your rights to import"); counsel
   should decide whether the Terms, the dashboard copy or the docs should
   say this explicitly.

## 1. Eligibility through a partner business

Google's [prerequisites](https://developers.google.com/my-business/content/prereqs)
(last updated 2026-08-28), quoted:

- *"Manage a Google Business Profile that is verified and active for 60+
  days. This GBP can be the applicant's own office or headquarters or it
  could belong to one of the clients they manage."*
- *"Have a website representing the business listed on the GBP."*
- *"Make sure that you are using an email address that is listed as an
  owner/manager on your business's GBP."*

ProofQL has no profile of its own, so a local business that is (or will
be) a ProofQL user adds the owner as a **manager**. The second sentence of
the first bullet is what makes this legitimate: the partner is a client
ProofQL serves. Make it true, not a formality: the partner should actually
put ProofQL on its site (the free plan is enough), which also gives the
demo video ([§4.6](#46-demo-video-script)) a real business to show.

### 1.1 Choose the applying Google account (owner decision)

One Google account does all of the following, so pick it first:

- is added as manager on the partner's profile;
- is an **Owner** (or at least Editor) of the production Google Cloud
  project, so the email on the application matches the project (one
  forum report notes theirs did, as a way to rule out mismatch);
- signs in to the application form (the form says: *"you must be signed in
  to the Google Account associated with your Business Profile"*).

Google's [FAQ](https://developers.google.com/my-business/content/faq)
(updated 2026-08-28) recommends *"a valid business email address that is
tied to your business domain"*. Options: a Google Account created on an
existing `@proofql.dev` address (needs a mailbox or forwarding that can
receive Google's verification mail; `support@proofql.dev` is Cloudflare
Email Routing, [`launch.md` §11](launch.md#11-support)), or a Google
Workspace user on `proofql.dev`. A personal `@gmail.com` account works
mechanically but reads worse on review. Do not use the partner's own
staff account.

### 1.2 What the partner does (send them this)

From Google's [Add & manage users](https://support.google.com/business/answer/3403100)
help page (checked 2026-10-07). The person doing this must be the profile's
owner (managers cannot add users):

1. Go to [business.google.com](https://business.google.com), or search the
   business name on Google while signed in, and open the profile.
2. **More** (⋮) → **Business Profile settings** → **People and access**.
3. **Add** → enter the email from §1.1 → access level **Manager** → **Invite**.
4. The owner accepts the invite from the email or from the profile; access
   is immediate. (New users have a 7-day period in which they cannot delete
   the profile or remove others; it does not affect the application.)

Manager, not Owner: it is the least access that meets the prerequisite,
and the partner keeps full control. A secondary write-up claims manager
applicants get rejected ([Xovion Labs, 2026-05-18](https://xovionlabs.com/blog/google-business-profile-api-hidden-gate/));
Google's prerequisite says "owner/manager", so start with Manager and ask
the partner to upgrade to Owner only if a rejection cites the role.

### 1.3 Checks before you apply

Signed in as the §1.1 account, on the partner's profile:

- [ ] **Verified, 60+ days.** The profile shows as verified (no "Get
      verified" prompt) and the partner confirms it was verified at least 60
      days ago. If they don't know, the profile's verification email or
      the earliest Insights/Performance month is a good proxy; when in
      doubt wait.
- [ ] **Active.** Not suspended, not marked permanently closed.
- [ ] **Website listed.** **Edit profile → Contact → Website** holds the
      partner's live site, and it loads.
- [ ] **Complete.** Name, category, address or service area, hours, phone,
      description and a few photos. Not a documented requirement, but an
      incomplete profile invites a "not a legitimate business" rejection.
- [ ] **You are listed.** **People and access** shows your email as Manager.
- [ ] **Cloud project owner.** The same account is Owner on the production
      Cloud project (IAM & Admin → IAM).
- [ ] **ProofQL's own site is live and honest.** `https://proofql.dev`
      describes the product and links the privacy policy and terms (it does,
      `apps/www/src/components/Footer.astro`); the FAQ says *"ensure the
      business website is updated and live."*

## 2. Apply for Basic API Access

### 2.1 Project number

The production Cloud project (one project serves preview and prod; quota
is per project). Prereqs: *"You'll find your Project Number in the Project
info card on your project's Dashboard."* Console → select the project →
**Cloud overview → Dashboard → Project info → Project number** (digits, not
the project id), or:

```sh
gcloud projects describe <project-id> --format='value(projectNumber)'
```

### 2.2 The form

<https://support.google.com/business/contact/api_default> → *What can we
help with?* → **Application For Basic API Access**. As of 2026-10-07 that
option no longer shows fields inline: it links to a guided workflow,
**"Apply for Google Business Profile API access"**
(`support.google.com/business/workflow/16726127`), whose first step is
*"Confirm your account"* (the signed-in Google account; **Switch account**
if it is not the §1.1 one). The later steps were not opened while writing
this, so their exact labels are unknown. The answers below cover every
item Google's pages and dated write-ups say it asks for
([prereqs](https://developers.google.com/my-business/content/prereqs);
[testimonial.to, 2026-05-13](https://testimonial.to/resources/google-business-profile-api);
[Localith, 2026-04-21](https://localith.ai/blog/google-business-profile-api-guide/)).
Paste the closest one into each field; keep the wording plain.

| Field (likely label) | Draft answer |
|---|---|
| Google account / contact email | the §1.1 address |
| Company name | ProofQL — or the legal entity name once it exists (the same name the privacy policy will carry) |
| Company website | `https://proofql.dev` |
| Google Cloud project number | from §2.1 |
| Project ID | the production project id |
| Business Profile you manage (name, address, or Maps link; sometimes the profile's website) | the partner's business name and address, its Maps link, and its website |
| Your relationship to that business | "ProofQL provides a review display service to [Partner]. I am a manager on its Business Profile so I can set up and support its connection." |
| Do you manage your own business or clients' businesses? | Clients' businesses (third-party tool) |
| Number of locations / profiles | "1 today ([Partner]); we expect tens in the first year, each connected by its own owner or manager through OAuth" |
| APIs you need | Google My Business API (v4: reviews list only), My Business Account Management API (accounts list), My Business Business Information API (locations list) |
| OAuth scope | `https://www.googleapis.com/auth/business.manage` |
| Use case / description (main free-text field) | the text below |

Use-case text (≈ 180 words; trim to the field's limit, keep the first and
last paragraphs):

> ProofQL (https://proofql.dev) is a review search service for small
> businesses, and for the web agencies and developers who build their
> websites. A business imports its own reviews; ProofQL indexes them so its
> website can show the reviews relevant to each page (for example, reviews
> that mention "implants" on a dental implants page), with the author's name
> and photo, a link to the review, and a Google source label.
>
> We request Business Profile API access to read reviews only. A business
> owner or manager signs in with Google and grants the business.manage scope;
> we list the accounts and locations they manage, they choose which verified
> locations to connect, and every six hours we call reviews.list for those
> locations. We never reply to reviews, edit a listing, create or verify
> locations, or act without the user's sign-in. Users can disconnect at any
> time in our dashboard, which deletes our tokens immediately.
>
> Our expected load is far below 300 QPM: one reviews.list call per connected
> location every six hours. The profile cited for eligibility is [Partner],
> a ProofQL customer whose profile I manage.

Do not describe it as a "platform" that resells access, and do not mention
features that do not exist (reply drafting, Q&A, posts). The FAQ says
*"Requests are reviewed within 14 days"*; the workflow's confirmation
quotes 7–10 business days; forum reports range from a few days to several
weeks with no email. **Record the case id in #44.** If ten business days
pass with quota still 0, file once more from the same account citing the
case id, not repeatedly.

## 3. After approval: quota, APIs and the switch

### 3.1 Confirm the quota

Prereqs: *"If your quota is 0 QPM (Queries Per Minute), your project has
not yet been approved. If your quota is set to 300 QPM, your project is
approved."* Console → **APIs & Services → Enabled APIs & services** →
**My Business Account Management API** → **Quotas & System Limits**: the
per-minute request limit reads **300**. The same on **My Business Business
Information API** ([limits](https://developers.google.com/my-business/content/limits),
updated 2026-08-28: 300 QPM per API). Record the date in #44.

### 3.2 Enable the APIs, and check v4

[Basic setup](https://developers.google.com/my-business/content/basic-setup)
(updated 2026-08-28) lists seven Business Profile APIs and notes *"The
Google My Business API is only visible in the Google Cloud console to
users who submit and receive approval."* ProofQL calls three: **Google My
Business API** (v4, reviews), **My Business Account Management API**,
**My Business Business Information API**. Enable those in the API Library.
If the project is in a Google Workspace organization, Business Profile
must be on for the org or every call is `403 PERMISSION_DENIED` (same page).

Then the go/no-go check for [risk 2](#risks-to-settle-before-applying):
**Google My Business API** appears in the Library and enables, and its
quota is not 0. If it will not enable ("not available to this consumer"),
stop here, keep the connector dark, and reply on the case (and the forum
thread) asking for the v4 reviews allowlist; the Places bootstrap keeps
working meanwhile.

### 3.3 Switch the connector on

The gate is one dashboard var, read by `connectorEnabled()` in
`apps/dashboard/app/lib/google.server.ts`:

```ts
return env.GOOGLE_CONNECTOR_ENABLED?.trim() === "true";
```

Anything but the string `"true"` keeps the Integrations tab on "Google
connection is pending approval" and the connect route
(`routes/app.projects.$slug.integrations.google.connect.ts`) answering 503.
Today it is `"false"` in both `env.preview.vars` and `env.prod.vars` of
`apps/dashboard/wrangler.jsonc`. The pipeline has **no** flag: its poller
runs whenever `CREDENTIALS_KEY`, `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` are set and the id does not start with `TBD-`
(`configured()` in `workers/pipeline/src/google-poll.ts`; otherwise it logs
`google.poll.skipped`), and it only finds work once a connection exists.

In order, per environment, preview first:

1. Track 2 of [`infra/provisioning.md`](../infra/provisioning.md#track-2--the-oauth-client-needed-for-the-connect-flow-minutes)
   is done: the real client id replaces `TBD-provision-in-m3` in
   `GOOGLE_CLIENT_ID` in **both** `apps/dashboard/wrangler.jsonc` and
   `workers/pipeline/wrangler.jsonc`, and the secrets
   (`GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_STATE_SECRET`, `CREDENTIALS_KEY`,
   identical key in dashboard and pipeline) are put.
2. In `apps/dashboard/wrangler.jsonc`, `env.preview.vars`:
   `"GOOGLE_CONNECTOR_ENABLED": "true"`. PR, merge, deploy.
3. Verify on preview: Integrations shows **Connect Google**; connecting with
   the §1.1 account lists the partner's location as verified; **Save
   locations** imports its reviews within seconds (`wrangler tail
   proofql-pipeline-preview` shows `google.poll.*` / an `ingest_runs` row of
   kind `google`). Confirm `metadata.hasVoiceOfMerchant` really drives the
   verified flag ([`google.md`](google.md#connecting-45) asks for this check).
4. Only after §4 (or a deliberate decision to run on test users, §5) repeat
   step 2 for `env.prod.vars`.

To go dark again: set it back to `"false"` and deploy. Existing
connections keep polling; to stop polling too, delete `GOOGLE_CLIENT_SECRET`
from the pipeline (provisioning.md "Switch it on").

## 4. OAuth consent screen production readiness

Google's pages for this section:
[sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
(updated 2026-08-19), [verification requirements](https://support.google.com/cloud/answer/13464321)
(no date shown), [branding](https://support.google.com/cloud/answer/15549049),
[data access](https://support.google.com/cloud/answer/15549135),
[audience / publishing status](https://support.google.com/cloud/answer/15549945),
[demo video](https://support.google.com/cloud/answer/13804565) (all checked
2026-10-07). The console's **Google Auth Platform** has Branding, Audience,
Data Access and Verification Center pages.

### 4.1 Sensitive or restricted?

- **Not restricted (verified by exclusion).** Restricted scopes need a
  third-party security assessment; Google's
  [restricted scope page](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
  (updated 2026-08-19) points to a list and its examples are Gmail and
  Drive; Business Profile is not among them, and
  [the scopes list](https://developers.google.com/identity/protocols/oauth2/scopes)
  (updated 2026-09-14) gives `business.manage` only as *"Manage your
  Business Profile on Google"*.
- **Sensitive: not stated by Google.** No Google page labels it.
  [Data access](https://support.google.com/cloud/answer/15549135) says the
  console categorises scopes automatically (non-sensitive is "read-only
  data", sensitive is "access to private user data"). By that definition a
  manage scope would be sensitive, which is what our docs have assumed.
  **But** two Google Developer forum reports
  ([2026-07-23, 2026-08-17](https://discuss.google.dev/t/384175))
  say the console lists it under **non-sensitive** and the Verification
  Center offers nothing to submit, while external users are still blocked
  with *"has not completed the Google verification process"*.
- **What to do:** after adding the scope (Data Access → **Add or remove
  scopes**; *"Only scopes for enabled APIs are listed"*, so enable the API
  first or paste the scope under **Manually add scopes**), read which
  section the console puts it in, and record that here. If sensitive,
  submit everything in §4.2–4.6. If non-sensitive, submit brand
  verification (§4.2–4.4) and test an external, non-test account before
  telling anyone it works; if it is blocked, open a case citing the forum
  thread. The material below covers both paths.

### 4.2 Branding

| Console field | Value | Google's rule |
|---|---|---|
| App name | **ProofQL** | "distinctively represents your business"; no Google brands |
| User support email | `support@proofql.dev` (`SUPPORT_EMAIL`), or a Google Group | shown on the consent screen; must be a group or the signed-in user's own address, so if `support@` is not selectable, create a Google Group with that address or use the §1.1 account |
| App logo | 120 × 120 px PNG of the ProofQL mark | "120px by 120px", "JPG, PNG, and BMP", "not larger than 1MB"; uploading one sends the app through verification before it is displayed |
| Application home page | `https://proofql.dev` | public, describes the app, not only a login page, links the privacy policy |
| Privacy policy | `https://docs.proofql.dev/privacy` (`PRIVACY_URL`) | must equal the link on the homepage (it does, from `@proofql/core`) |
| Terms of service | `https://docs.proofql.dev/terms` (`TERMS_URL`) | required for external production apps |
| Authorized domains | `proofql.dev` | every domain must be verified in Search Console |
| Developer contact | the §1.1 address and the owner's | where Google sends verification mail |

The logo: no 120 px PNG is in the tree (`apps/www/public` has
`favicon.svg` and `og.png`). Export one from the favicon mark, e.g.
`rsvg-convert -w 120 -h 120 apps/www/public/favicon.svg > proofql-120.png`,
on a solid background so it reads on both consent-screen themes.

Two Google rules the current setup meets, worth knowing: the privacy
policy "should be hosted within the domain that hosts your homepage"
(`docs.proofql.dev` is a subdomain of `proofql.dev`; a Search Console
**Domain** property covers all subdomains, below), and the homepage's
privacy link must be the same URL as the consent screen's.

### 4.3 Search Console domain verification

From [Search Console help](https://support.google.com/webmasters/answer/9008080)
(checked 2026-10-07), as a Cloud project Owner or Editor:

1. [search.google.com/search-console](https://search.google.com/search-console)
   → **Add property** → **Domain** → `proofql.dev` (Domain, not URL prefix:
   *"Verifying ownership of a root domain automatically verifies ownership
   of all subdomains"*).
2. Copy the `google-site-verification=…` TXT value.
3. Cloudflare → `proofql.dev` → **DNS → Records → Add record**: type
   `TXT`, name `@`, content the value, TTL auto.
4. Back in Search Console → **Verify**. Propagation "can take a few minutes
   or even days".
5. The Google account that verified it must be an Owner/Editor of the Cloud
   project; if a different account verified, add the project account as an
   Owner of the property (Settings → Users and permissions).

Then add `proofql.dev` under **Branding → Authorized domains**. The
redirect URIs live on the OAuth client, not here: prod is
`https://app.proofql.dev/app/integrations/google/callback` (under the
authorized domain); preview's `*.workers.dev` URI is not, and only works
while the app is in Testing. Give preview a `*-preview.proofql.dev` host
before then if the published app must serve it.

### 4.4 Privacy policy and the Limited Use disclosure

Google requires the policy to *"disclose how your app accesses, uses,
stores, and/or shares Google user data"* and that *"Your use of Google
user data must be limited to the practices disclosed"*
([requirements](https://support.google.com/cloud/answer/13464321)); the
[User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
(last updated 2024-02-15) sets the Limited Use rules for sensitive and
restricted scopes.

**What `privacy.mdx` already has (section "Google user data"):** the
User Data Policy link; the affirmation *"ProofQL's use and transfer of
information received from Google APIs to any other app will adhere to the
Google API Services User Data Policy, including the Limited Use
requirements"* (the wording apps conventionally use; the Google pages checked here do not
mandate an exact sentence); what is accessed, why, what is not done
(advertising, sale, data brokers, credit, AI training), human access, and
how to revoke. That is a sound base. **Gaps** for counsel:

1. **Retention of Google review data is not stated.** The retention list
   covers tokens and Places rows but not reviews imported through the
   connection, and [risk 1](#risks-to-settle-before-applying) may force a
   30-day cycle. Add one of the two texts below, matching the decision.
2. **Derived data.** Excerpts and embeddings are made from Google data;
   say so in the Google section, since Limited Use applies to "data
   aggregated, anonymized, or derived from them".
3. **Disassociation.** The GBP API policies require a way to stop use and
   regain exclusive control within seven business days; Disconnect does it
   at once. Saying so costs one sentence.
4. **The draft banner.** A page that says "Draft — needs counsel" and "not
   a legal commitment" is not a policy a reviewer can accept. Verification
   waits for §5 of launch.md to land.
5. A small inaccuracy in `terms.mdx` ("Source platform terms"): it
   attributes the name/photo/link display rule to "Google Business Profile
   policies"; that rule is the Places API's. The GBP API policies ask that
   attribution Google provides be displayed unaltered. Counsel may want both
   named separately.

Draft text for the owner and counsel (not applied to the legal pages):

> **Retention.** Reviews we read through your Google connection, and the
> excerpts and search vectors derived from them, are kept while your project
> is connected and [choose one: *refreshed from Google at least every 30
> days; a review Google no longer returns is deleted at the next refresh* /
> *until you delete them or the project*]. Disconnecting deletes our Google
> tokens at once; [choose one: *reviews imported through the connection are
> deleted within 30 days of disconnecting* / *reviews already imported stay
> in your project until you delete them*]. Deleting a project or workspace
> deletes them as described under Retention and deletion.
>
> **Derived data.** To make reviews searchable we split their text into
> verbatim excerpts and compute numeric vectors from them. These are Google
> user data for the purposes of this section: they are used only to answer
> searches for the project that imported the reviews, are never shared with
> other customers, and are deleted with the reviews.
>
> **Stopping use.** Disconnecting in the dashboard ends ProofQL's access to
> your Business Profile immediately and deletes our tokens; ProofQL never
> holds owner or manager rights on your profile, so you keep exclusive
> control throughout.

### 4.5 Scope justification

Paste into the Data Access / verification "How will the scopes be used?"
field (Google asks for *"detailed justification for each requested
sensitive scope, as well as an explanation for why a narrower scope isn't
sufficient"*):

> ProofQL requests https://www.googleapis.com/auth/business.manage to read
> the Google reviews of the business locations the signed-in user owns or
> manages, so the business can display them on its own website.
>
> After consent we call three read methods: accounts.list (My Business
> Account Management API) and locations.list (My Business Business
> Information API) so the user can choose which of their verified locations
> to connect, and accounts.locations.reviews.list (My Business API v4) for
> those locations, every six hours. We do not call any method that writes:
> no review replies, listing edits, posts, location creation or
> verification. The user sees the connected locations, last sync time and a
> Disconnect button in our dashboard; disconnecting deletes our tokens.
>
> No narrower scope exists. business.manage is the only OAuth scope the
> Business Profile APIs accept (the reference for
> accounts.locations.reviews.list lists business.manage and the legacy
> plus.business.manage; the OAuth 2.0 scopes list gives only
> business.manage for the Business Profile API). There is no read-only
> variant such as business.readonly. Public alternatives do not meet the
> need: the Places API returns at most five reviews per place, and gives no
> way to confirm the user manages the business.

### 4.6 Demo video script

Google's rules: show *"the end-to-end flow of your app including the OAuth
grant process"*, *"the complete OAuth Consent Screen"* with *"the same
exact scopes you are requesting"*, language **English**, the browser
address bar showing *"your app's OAuth client ID"*, and *"the app
functionalities that utilize the requested OAuth scopes"*; upload to
YouTube as **Unlisted**.

**Prerequisites:** recordable on **preview** only after §3 (before
approval, discovery fails on 0 quota) with the preview var on, the
consent screen's Branding filled in, the §1.1 account added as a test user
(or the app published), the partner's written OK to show its reviews in an
unlisted video, and a page with the snippet (the partner's staging page,
or the cdn worker's `/demo/` page with the project's publishable key and
the page's origin in allowed origins). Browser: a clean profile, English
UI, zoom 125 %, no extensions, address bar visible throughout. Narrate or
caption each shot. Target 3–4 minutes.

| # | Screen | Action | Caption / narration |
|---|---|---|---|
| 1 | `https://proofql.dev` | Scroll once; hover the footer **Privacy** link | "ProofQL shows a business's own reviews on its own website. Privacy policy linked here." |
| 2 | Preview dashboard, signed in, project list | Open the partner's project → **Integrations** | "A business owner connects their Google Business Profile." |
| 3 | Integrations tab, Not connected | Click **Connect Google** | "Connecting asks Google for read access to reviews." |
| 4 | Google account chooser | Pick the §1.1 account. **Pause**; zoom into the address bar | "The request URL carries ProofQL's OAuth client ID: `client_id=…apps.googleusercontent.com`." Freeze on the id for 3 s. |
| 5 | Consent screen | Show the app name "ProofQL", logo, the scope line **"Manage your Business Profile on Google"**, privacy and terms links. Expand the scope details if offered. Click **Continue / Allow** | "Exactly one scope: business.manage. ProofQL uses it read-only." |
| 6 | Back on Integrations, Connected | Show the badge, **Locations** list with the partner's location (verified) and any unverified one disabled | "ProofQL lists the locations this user manages. Only verified locations can be connected." |
| 7 | Tick the partner's location → **Save locations** | Wait for the success message | "The user chooses which locations to import." |
| 8 | Integrations card after a few seconds (reload) | Show **Last synced** / **Last run** with counts | "Reviews arrive in seconds; we check for new and edited reviews every six hours." |
| 9 | **Reviews** tab | Filter source Google; open one review: author, rating, text, date, Google link | "These are the business's Google reviews, with author attribution." |
| 10 | **Playground** | Query a real topic from the reviews (e.g. "friendly staff" or a service the business offers); show results with excerpt, highlight, author, Google badge | "A website asks a question; ProofQL returns the reviews that answer it." |
| 11 | The page with the snippet | Load it; point at the rendered reviews, author name and photo, Google badge linking to the review | "On the business's own site, with Google attribution. Nothing is posted to Google." |
| 12 | Integrations → **Disconnect Google** → confirm | Show the status return to Not connected | "The user can disconnect at any time; our tokens are deleted immediately." |
| 13 | `myaccount.google.com/permissions` | Show ProofQL removed (or remove it there) | "Access can also be revoked from the Google Account." |

Do not show other tabs, secrets, `wrangler`, the database or the fake
Google server. Re-record if any shot shows a 4xx/5xx.

### 4.7 Submit

Branding filled and saved, Search Console verified, the legal pages final
(below), the video unlisted: Google Auth Platform → **Audience** →
**Publish app** (Testing → In production) → **Verification Center** →
**Prepare for verification** / **Submit**. Google: *"typically takes 3-5
business days"*. Reply to Google's emails from the developer contact
address; they often ask for a re-recorded video or a policy tweak.

### 4.8 Legal placeholders to fill before submitting

From `docs/site/src/content/docs/` on 2026-10-07; launch.md §5 step 2 is
done when `grep -rn "PLACEHOLDER\|LegalNotice\|COMPANY LEGAL NAME\|\[ADDRESS\]\|GOVERNING LAW" docs/site/src/content/docs`
prints nothing.

`privacy.mdx`

- [ ] l.10 `<LegalNotice />` draft banner; l.12 "(draft)" in "Last updated"
- [ ] l.12, l.156 `[COMPANY LEGAL NAME]`, `[ADDRESS]`
- [ ] l.38 controller/processor split; publish a DPA with SCCs?
- [ ] l.90 law-enforcement request position
- [ ] l.111 Neon point-in-time restore window (N days)
- [ ] l.112 Workers plan in use at launch (log retention 3 vs 7 days)
- [ ] l.113 waitlist retention
- [ ] l.114 support email retention (N months/years)
- [ ] l.134 GDPR legal bases; EU/UK Art. 27 representative?
- [ ] l.144 international transfer mechanism (SCCs / DPF / other)
- [ ] l.156 dedicated `privacy@` address?
- [ ] *(not a placeholder)* the §4.4 gaps: Google data retention, derived data, stopping use

`terms.mdx`

- [ ] l.11 `<LegalNotice />`; l.13 "(draft)"
- [ ] l.25, l.121 `[COMPANY LEGAL NAME]`, `[ADDRESS]`
- [ ] l.69 billing, renewal, refund, tax and price-change terms
- [ ] l.73 SLA for paid plans
- [ ] l.74 notice period before discontinuing the Service (N days)
- [ ] l.80 inactivity period for free accounts (N months)
- [ ] l.86 agencies managing client projects under one account
- [ ] l.99 liability cap fixed amount
- [ ] l.105 indemnity scope and procedure
- [ ] l.109 `[GOVERNING LAW / JURISDICTION]` (×2), venue, arbitration, consumer carve-outs
- [ ] l.117 notice period for changes (30 days?)

`subprocessors.mdx` (linked from the privacy policy)

- [ ] l.9 `<LegalNotice />`; l.11 "(draft)"
- [ ] l.13 DPA in place with each subprocessor, linked
- [ ] l.19 R2/KV storage and Workers AI inference locations

## 5. The 100-user cap and working within it

Google, [audience page](https://support.google.com/cloud/answer/15549945):
in **Testing**, an app is limited to *"up to 100 test users"* and
*"Authorizations by a test user will expire seven days from the time of
consent"*; an app **In production** that requests unapproved sensitive
scopes shows the unverified-app warning and has *"a 100-user lifetime
cap"*. [Unverified apps](https://support.google.com/cloud/answer/7454865):
the cap counts *"100 new users in total, after the app presents the
unverified app screen"*.

Two ways to run before verification completes, for the first design
partners:

| | Testing (recommended until verified) | In production, unverified |
|---|---|---|
| Who can connect | only Google accounts listed under Audience → Test users (≤ 100) | anyone, after clicking through "Google hasn't verified this app" |
| Token life | 7 days: every connection goes `needs_reauth` weekly and the user must **Reconnect** ([`google.md`](google.md#needs_reauth)) | normal |
| Cap | the test-user list; remove a user to free the slot | 100 **lifetime** users; slots are not given back |
| Risk | weekly reconnect friction | burns a scarce, non-resettable allowance; the warning screen looks bad to customers |

How to work within it:

- Stay in **Testing** and add each partner's Google account (the one that
  manages their profile) as a test user when they sign up. Tell them up
  front that Google asks them to reconnect weekly until verification;
  the dashboard already shows **Needs reconnect** and the poller keeps
  their imported reviews.
- Keep the Places bootstrap as the default onboarding for everyone else;
  the connector is the upgrade.
- Ask for the Google account at signup only from businesses that will
  actually display reviews, so slots go to real use.
- Remove test users who churned; the list, not a lifetime counter, is the
  limit in Testing.
- Submit verification (§4.7) as soon as the video can be recorded; it is
  3–5 business days and removes both limits.
