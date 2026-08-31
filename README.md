# HR Operations Assistant

A bilingual (Arabic / English) HR agent built on [Lua](https://heylua.ai) for a
50,000-employee industrial group headquartered in Riyadh, with operations in
Saudi Arabia, the UAE, Egypt and Jordan.

Office staff reach it through a web widget; field workers reach it on WhatsApp.
It reads and writes BambooHR as the system of record, answers policy questions
from a vector-searched knowledge base, and pushes live activity to a Google
Sheet.

**All four workflows are implemented** — Onboarding, Leave Management, SOP
Requests and Daily Performance Management. The brief asked for two; the first
two were built and submitted, and the remaining two followed. Iqama expiry
alerting runs across all of them.

---

## Live

| | |
|---|---|
| Agent ID | `baseAgent_agent_1788171476995_6gsfvk1sh` |
| WhatsApp | [Link your number](https://wa.me/13023778932?text=link-me-to:baseAgent_agent_1788171476995_6gsfvk1sh) |
| Web widget | `index.html` — LuaPop, one script tag |
| Live dashboard | [HR Agent — Live Dashboard](https://docs.google.com/spreadsheets/d/1yfEk7S2sW9XbWsv6VSkHoRZsdvfeMm1Bm_MfER8PY_w/edit?usp=sharing) |
| HRIS | BambooHR trial, subdomain `notyet` |

---

## Architecture

```
        Web widget (LuaPop)          WhatsApp
                 └───────────┬───────────┘
                             │
                   ┌─────────▼─────────┐
                   │   Lua Agent OS    │   persona, LLM routing,
                   │                   │   conversation state,
                   │  7 skills         │   channel delivery
                   │  16 tools         │
                   │  2 scheduled jobs │
                   └─────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼──────┐ ┌─────▼─────┐ ┌──────▼───────┐
     │ Domain rules  │ │ BambooHR  │ │ Google Sheets│
     │ (pure TS)     │ │ REST API  │ │ Apps Script  │
     │               │ │           │ │              │
     │ countryRules  │ │ employees │ │ LeaveLog     │
     │ leave         │ │ directory │ │ SOPGaps      │
     │ gratuity      │ │ time_off  │ │ IqamaAlerts  │
     │ iqama         │ │ reports   │ │ Performance  │
     │ tenure        │ └───────────┘ │ SOPRequests  │
     │ sopRequests   │               └──────────────┘
     │ performance   │
     └───────────────┘   ┌──────────────────────┐
                         │ Lua Data API         │
                         │ hr_policies (vector) │
                         │ sop_requests         │
                         │ performance_checkins │
                         └──────────────────────┘
```

The platform owns infrastructure, model selection, tool-calling and channel
delivery. This repository owns business logic and nothing else.

### Layering

**`src/domain/`** — pure functions, no I/O, no platform imports. Every
statutory rule lives here and is unit-tested in isolation. This is the layer
that would survive a change of platform or HRIS.

**`src/integrations/`** — BambooHR and Google Sheets. One file each, so the
mapping from an external schema to the domain model is auditable in one place
and a mock fallback needs one switch rather than a flag threaded through the
tool layer.

**`src/tools/`** — thin `LuaTool` wrappers. Validate input, call the domain,
return structured data. No business rules.

**`src/knowledge/`** — the eight mock SOPs and their loader.

### Two design decisions worth explaining

**Identity is resolved below the model, never from the conversation.** The
trust anchor is `user._luaProfile` — the userId, verified phone numbers and
email addresses the platform supplies from the channel the message actually
arrived on. It is read-only, and nothing the model produces can change it.

On first contact the agent matches those against BambooHR by work email or
mobile number; an exact single match binds the account to a personnel record.
Where the channel carries nothing usable, it falls back to a challenge. After
that, every tool reads the employee from the stored binding, and
`domain/authorization.ts` decides whether the caller may see anyone else.

The practical effect: an employee asking *"what is Madison's gratuity?"* is
refused by the tool layer, not deflected by the model. A prompt cannot argue
with a function that never received the record.

**Tools refuse; they don't throw.** A failure returns
`{ ok: false, error, detail, action }` — `detail` is written to be read aloud
to the employee, `action` tells the model what to do next. A thrown exception
would surface to a field worker as "something went wrong".

Live example, with BambooHR deliberately unconfigured:

```
> كم رصيد إجازتي؟ رقمي الوظيفي 1001

  → check_leave_balance { employeeId: "1001", leaveType: "annual" }
  → { ok: false, error: "hris_unavailable", action: "Tell the employee
      HR systems are briefly unavailable and to try again shortly." }

< أنظمة الموارد البشرية غير متاحة حاليًا، يرجى المحاولة مرة أخرى بعد قليل.
```

### Bilingual handling

There is no translation table. Arabic and English are handled by the model
under persona instruction, which also covers the mixed Arabic-English that Gulf
office staff actually write. Tools return structured data — numbers and codes,
never sentences — so the language of the answer is decided at the point of
speaking, not baked into the business logic.

---

## Tools

| Tool | Skill | What it does |
|---|---|---|
| `verify_my_identity` | identity | Binds the channel identity to a personnel record |
| `whoami` | identity | Who the agent believes it is talking to, and what they may do |
| `get_employee` | onboarding | Record, country, tenure |
| `check_probation` | onboarding | Validates a probation period against the statutory cap |
| `start_onboarding` | onboarding | Country-specific document list, probation terms, orientation |
| `check_leave_balance` | leave | Statutory entitlement minus approved and pending |
| `request_leave` | leave | Validates, submits to BambooHR, logs to the dashboard |
| `calculate_gratuity` | leave | End-of-service award |
| `check_iqama_expiry` | compliance | Saudi residency permit status and urgency |
| `search_policies` | compliance | Vector search over the SOP knowledge base |
| `submit_sop_request` | requests | Raise an HR service request, with SLA and owner |
| `check_request_status` | requests | Where a request got to, by reference or employee |
| `update_request_status` | requests | Advance a request through its lifecycle. HR only. |
| `submit_daily_checkin` | performance | A lead's daily accomplishments, blockers and 1–5 ratings |
| `get_team_summary` | performance | Weekly averages, trends, blockers, reporting rate |
| `seed_policies` | setup | One-off knowledge-base load. Not for conversation. |

### Scheduled jobs

**`iqama-expiry-sweep`** runs `0 7 * * 0-4` in `Asia/Riyadh` — 07:00 Sunday to
Thursday, the Gulf working week. It scans the directory, skips non-Saudi staff,
writes alerts to the dashboard and digests the urgent ones to HR.

**`daily-checkin-reminder`** runs `0 16 * * 0-4` — end of the working day. It
nudges team leads who owe a check-in, because daily performance reporting fails
on collection rather than on analysis. A dashboard nobody feeds is worse than
no dashboard: it looks authoritative while being empty.

Both are guarded on `job.execution.occurrenceId`, since jobs run at least once
and the same occurrence can be retried.

---

## Identity and access

### Who the caller is

`verify_my_identity` runs before anything else touches a record. It reads
`user._luaProfile` — platform-supplied, immutable — and matches the verified
email addresses and mobile numbers against BambooHR.

Phone matching compares the last nine digits. A Saudi mobile is stored as
`+966 5X XXX XXXX` and arrives from WhatsApp as `9665XXXXXXXX`; comparing the
significant tail sidesteps country codes, leading zeros and punctuation without
parsing dialling plans for four countries.

An exact single match binds silently, so in practice verification is invisible.
More than one match is treated as **no** match — an ambiguous identity is worse
than none. Where the channel carries nothing usable, the fallback is employee
ID plus start date. A wrong ID and a wrong date return the *same* failure, so
the response cannot be used to discover which employee IDs exist.

Role and reporting line are re-read from BambooHR on every call rather than
cached on the account. That costs a request and means a promotion or a team
move takes effect immediately, instead of persisting until someone remembers
to clear a stale claim.

### Who may see what

| | Own record | Reports' records | Reports' pay and balances | Anyone |
|---|---|---|---|---|
| Employee | ✓ | — | — | — |
| Manager | ✓ | ✓ | — | — |
| HR | ✓ | ✓ | ✓ | ✓ |

Two deliberate lines:

**A manager cannot see a report's entitlements.** They see that the person
exists, where they sit and how their team is performing — but leave balances
and end-of-service figures stay between the employee and HR. That is a
judgement call, and it is in one readable function rather than spread across
thirteen tools.

**Not even HR can file a check-in for a team they did not observe.** A
performance rating is a first-hand judgement, not an administrative act, so
`submit_daily_checkin` takes no team-lead parameter at all — the lead filing it
is always the caller, and the ratings must be for their own reports.

Refusals are worded so they cannot be mined. A request reference the caller may
not see returns the same response as one that does not exist, because
distinguishing them would confirm the reference is real.

`domain/authorization.ts` is pure and has no imports, so the whole policy is
exercised by 53 assertions covering every role against every action — including
that `Chrome Platform Engineer` does not accidentally parse as HR.

---

## The two later workflows

### SOP Requests

`search_policies` answers *"what is the transfer policy?"*. These tools handle
the other half — an employee who wants to actually make the request.

Seven request types, each with its own owning department and SLA: salary
certificates and employment letters (2 working days, People team), transfers
(10 days, HR Business Partner), exit and re-entry visas and Iqama renewals
(5 and 10 days, Government Relations, Saudi Arabia only), housing allowance
advances (7 days, People and Finance), and a general catch-all.

Two details worth noting:

**Due dates count working days on a Sunday-to-Thursday week.** Quoting a
calendar-day SLA in Riyadh overpromises by two days in most weeks.

**Missing details are asked for, never invented.** Each type declares the
fields it needs. Submit without them and the tool returns the exact questions
to ask, in English and Arabic, rather than filing an incomplete request.

### Daily Performance Management

No system exists for this in the client today, so the agent is the system of
record. A team lead files what the team accomplished, what is blocking them,
and a 1–5 rating per member. Check-ins are stored in Lua's Data collection and
mirrored to the sheet **one row per member per day** — flat, so the dashboard
can pivot and chart rather than just accumulate.

`get_team_summary` answers *"how did Ahmad's team perform this week?"* with
per-member averages, direction of travel, blockers recurring across three or
more days, and the reporting rate.

Three deliberate choices:

**A second check-in on the same day replaces the first.** Leads correct
themselves, and a weekly average built on duplicates is quietly wrong.

**Trends compare the first and last thirds, not a fitted line.** With three to
five data points a regression reads noise as signal, and a lead asking "is she
improving" wants a robust answer rather than a precise one.

**No check-ins is reported as a reporting gap, not as a bad week.** The agent
is instructed never to infer performance from missing data.

---

## Statutory rules

Every figure is traceable to a statute, cited in a `source` field that flows
through to tool output — so "where does 21 days come from" is answerable on
screen.

### Annual leave

| Country | Entitlement | Source |
|---|---|---|
| Saudi Arabia | 21 days, 30 after 5 years | Labor Law Art. 109 |
| UAE | 30 days after 1 year; 2 days/month from 6–12 months | Decree-Law 33/2021 Art. 29 |
| Egypt | 21 days, 30 after 10 years; 15 days from 6–12 months | Labour Law 12/2003 Art. 47 |
| Jordan | 14 days, 21 after 5 years | Labour Law Art. 61 |

### End-of-service gratuity

**Saudi Arabia** — half a month per year for the first five, a full month
thereafter, pro rata for partial years. On resignation the award is reduced by
service: nothing under two years, one third to five, two thirds to ten, full
beyond. *(Arts. 84–85)*

**UAE** — 21 days of **basic** wage per year for the first five, 30 thereafter,
capped at two years' wage. No resignation reduction; the previous tapering was
abolished in 2021. Nothing below one year. *(Art. 51)*

**Egypt and Jordan** — neither runs a Gulf-style scheme. Retirement provision
goes through social insurance and Social Security respectively, and a separate
end-of-service payment arises only for uncovered service. The tool returns
`amount: null` with an indicative figure and an instruction to escalate. It
will not quote a number it cannot stand behind.

### Probation caps

Saudi Arabia 90 days (180 by written agreement) · UAE 180 · Egypt 90 · Jordan 90

### Sick leave

Graduated, not flat. Saudi Arabia: 30 days full pay, then 60 at three-quarter
pay, then 30 unpaid *(Art. 117)*. The tool returns the tiers rather than the
sum, because the sum misrepresents what an employee will be paid.

---

## Knowledge base

Eight SOPs in the `hr_policies` collection, semantically searched at a 0.7
threshold: onboarding, annual leave, sick leave, gratuity, internal transfers,
salary certificates, exit and re-entry visas, housing allowance.

**Every statutory figure in the policy text is generated from the rules
engine**, not typed by hand — `annualLeaveTable()` and `probationTable()` read
`COUNTRY_RULES` and phrase themselves from it. `policies.test.ts` then parses
the generated prose back out and asserts each number against the engine. A
knowledge base that contradicts the calculator is a class of bug this cannot
have.

**When nothing matches**, the question is written to the `SOPGaps` tab and the
agent is instructed to say no documented policy covers it. It does not assemble
an answer from adjacent policies. The accumulated rows double as the backlog
for whoever writes the missing SOPs.

---

## Running it

```bash
npm install
lua auth configure

lua env sandbox -k BAMBOOHR_API_KEY    -v "..."
lua env sandbox -k BAMBOOHR_SUBDOMAIN  -v "notyet"
lua env sandbox -k SHEETS_WEBAPP_URL   -v "https://script.google.com/macros/s/.../exec"

lua compile
lua test                    # pick a tool, try it
lua test                    # seed_policies, once, to load the knowledge base

lua env production -k BAMBOOHR_API_KEY   -v "..."   # push does not carry env vars
lua env production -k BAMBOOHR_SUBDOMAIN -v "notyet"
lua env production -k SHEETS_WEBAPP_URL  -v "..."

lua push && lua deploy
lua chat -e production -m "كم رصيد إجازتي؟ رقمي الوظيفي 7"
```

### Environment

| Variable | Required | Notes |
|---|---|---|
| `BAMBOOHR_API_KEY` | yes | Must be generated by an account admin — a key inherits its creator's permissions |
| `BAMBOOHR_SUBDOMAIN` | yes | The part before `.bamboohr.com` |
| `SHEETS_WEBAPP_URL` | no | Without it, logging degrades gracefully rather than failing |
| `SHEETS_SECRET` | no | Must match `SHARED_SECRET` in the Apps Script properties |
| `HR_EMPLOYEE_IDS` | no | Comma-separated. Set it and the HR job-title heuristic is disabled entirely. |
| `BAMBOOHR_IQAMA_NUMBER_FIELD` | no | Defaults to `customIqamaNumber` |
| `BAMBOOHR_IQAMA_EXPIRY_FIELD` | no | Defaults to `customIqamaExpiry` |
| `BAMBOOHR_TIME_OFF_*_ID` | no | Overrides for annual / sick / unpaid, if auto-discovery is wrong |
| `BAMBOOHR_MOCK` | no | `true` runs against fixtures spanning all four countries |

### Google Sheets

`apps-script/Code.gs` deploys as an Apps Script Web App. Run `setup()` once to
create the tabs, then Deploy → Web app (execute as Me, access Anyone). A `GET`
on the `/exec` URL returns a health check.

This is deliberately not the Sheets REST API. That route needs an OAuth2
service account with RS256-signed JWTs — hours of work to support a write-only
log, and the wrong place to spend a time-boxed build.

### Tests

```bash
npx tsx src/domain/domain.test.ts         # 58 — statutory boundaries
npx tsx src/domain/workflows.test.ts      # 59 — SLA and aggregation
npx tsx src/domain/authorization.test.ts  # 53 — who may see whose record
npx tsx src/knowledge/policies.test.ts    # 61 — policy text vs rules engine
```

231 assertions in total, and a clean `tsc --noEmit`.

The statutory suite pins the exact year at which each tier flips, both sides of
every resignation cliff, the UAE cap, and the Iqama tier edges — the places
where an off-by-one costs an employee real money. The workflow suite covers the
working-day SLA arithmetic across a Friday-Saturday weekend, and the 2.5
threshold that decides whether a team member gets surfaced to their manager.

The authorization suite is written as an explicit role-by-action matrix rather
than a handful of happy paths, because an authorization bug is invisible until
someone finds it and the failure mode is disclosure rather than an error.

---

## Assumptions and limitations

**BambooHR is a trial account with US sample data.** A handful of employees
were edited into the four operating countries to exercise the rules. The rest
resolve as `unsupported_country` and are refused rather than guessed at, which
is the correct behaviour but means the directory is not representative.

**Iqama number and expiry are BambooHR custom fields**, not native ones. Field
aliases are configurable because they differ per account.

**Time-off type IDs resolve in three layers** — an env override, then the
account's own `/v1/meta/time_off/types`, then the IDs observed on this tenant
(78/79/83). They were briefly hardcoded as 1/2/3, which was wrong here and
silently so: a sick request filed under the annual type looks successful and is
only caught at payroll.

**BambooHR returns a created request's ID in the `Location` header**, not the
response body — `submitTimeOff` parses it from there. This is undocumented and
was found by inspection.

**The Sheets endpoint is protected by a shared secret, not by authentication.**
Set `SHARED_SECRET` in the Apps Script properties and `SHEETS_SECRET` in the
agent's environment; the deployment then rejects writes from anyone who merely
has the URL. Leave the script property unset and it stays open. A real
deployment wants a service account.

**Sick leave tiers outside Saudi Arabia** are the common statutory position
rather than a verified reading, and should be confirmed with local counsel
before production. The Saudi tiers are Art. 117 as written.

**Egypt and Jordan gratuity is deliberately unresolved.** Both depend on
social-insurance history the HRIS does not hold. Returning a confident number
would be worse than returning none.

**Approval routing lives in BambooHR.** A submitted request enters BambooHR's
own approval chain; the agent does not model manager hierarchy itself.

**The SOPs are mock content** written for this exercise, not real company
policy.

**Performance ratings are one lead's judgement**, self-reported, across a
handful of days. The agent is instructed to present a low average as a prompt
for a conversation rather than a verdict, and never to speculate about why a
rating is low. That framing is a persona instruction, not an enforced control.

**The identity challenge is a start date, not a real second factor.** It is
known to the employee and to HR and is harmless if it leaks, which makes it
reasonable for a demo — and it is rate-limited to five attempts before a
fifteen-minute lockout, counted on the account so a new conversation does not
reset it. Production should send a one-time code to the number already on the
personnel record. Auto-binding by verified email or mobile is genuinely strong;
the fallback is the weak link.

**HR privilege falls back to a job-title heuristic.** Set `HR_EMPLOYEE_IDS` and
an explicit allowlist takes over completely — a title cannot then bypass it.
Left unset, department and title are matched, which is derived from the HRIS
(so it revokes itself on a job change) but is still inference.

**Request SLAs are operational conventions, not statute.** Unlike leave and
gratuity, nothing in labour law sets them; they are placeholders a real client
would replace with their own service catalogue.

**Request status is advanced by HR, not by the owning system.**
`update_request_status` lets HR move a request through its lifecycle, and
`canTransition` refuses to reopen anything already completed or rejected. What
is still missing is a webhook from whatever system Government Relations or
Finance actually work in, so status changes reach the employee without someone
retyping them.

---

## What I would do next

1. **Replace the identity challenge with a one-time code** to the number
   already on the personnel record. Rate limiting makes the current fallback
   defensible; it does not make it strong.
2. **Webhooks in both directions** — from BambooHR when a manager approves
   leave, and from Government Relations and Finance when a request moves, so
   status reaches the employee without anyone retyping it.
3. **Nitaqat / Saudization reporting** — named in the brief and still not built.
   The natural next workflow given the Riyadh HQ.
4. **Move Sheets to a service account.** The shared secret means holding the
   URL is not enough, but it is a password in an environment variable.
5. **Real SOP ingestion** — the current knowledge base is eight documents; a
   50,000-person group has hundreds, and the `SOPGaps` log is the right input
   for prioritising which to load first.
