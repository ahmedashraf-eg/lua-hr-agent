# HR Operations Assistant

A bilingual (Arabic / English) HR agent built on [Lua](https://heylua.ai) for a
50,000-employee industrial group headquartered in Riyadh, with operations in
Saudi Arabia, the UAE, Egypt and Jordan.

Office staff reach it through a web widget; field workers reach it on WhatsApp.
It reads and writes BambooHR as the system of record, answers policy questions
from a vector-searched knowledge base, and pushes live activity to a Google
Sheet.

**Workflows implemented: Onboarding and Leave Management** (two of the four in
the brief). SOP lookup and Iqama expiry alerting support both and are included.

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
                   │  4 skills         │   channel delivery
                   │  9 tools          │
                   │  1 scheduled job  │
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
     │ iqama         │ └───────────┘ └──────────────┘
     │ tenure        │
     └───────────────┘        ┌──────────────────┐
                              │ Lua Data API     │
                              │ hr_policies      │
                              │ 8 SOPs, vector   │
                              └──────────────────┘
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

**Every tool takes `employeeId` as a required input.** The model extracts it
from the conversation. There is no default and no ambient "current employee",
so it is structurally impossible for one employee's question to be answered
from another's record.

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
| `get_employee` | onboarding | Record, country, tenure |
| `check_probation` | onboarding | Validates a probation period against the statutory cap |
| `start_onboarding` | onboarding | Country-specific document list, probation terms, orientation |
| `check_leave_balance` | leave | Statutory entitlement minus approved and pending |
| `request_leave` | leave | Validates, submits to BambooHR, logs to the dashboard |
| `calculate_gratuity` | leave | End-of-service award |
| `check_iqama_expiry` | compliance | Saudi residency permit status and urgency |
| `search_policies` | compliance | Vector search over the SOP knowledge base |
| `seed_policies` | setup | One-off knowledge-base load. Not for conversation. |

**`iqama-expiry-sweep`** runs `0 7 * * 0-4` in `Asia/Riyadh` — 07:00 Sunday to
Thursday, the Gulf working week. It scans the directory, skips non-Saudi staff,
writes alerts to the dashboard and digests the urgent ones to HR. Guarded on
`job.execution.occurrenceId`, since jobs run at least once.

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
| `BAMBOOHR_IQAMA_NUMBER_FIELD` | no | Defaults to `customIqamaNumber` |
| `BAMBOOHR_IQAMA_EXPIRY_FIELD` | no | Defaults to `customIqamaExpiry` |
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
npx tsx src/domain/domain.test.ts       # 58 assertions — statutory boundaries
npx tsx src/knowledge/policies.test.ts  # 61 assertions — policy text vs engine
```

The domain suite pins the exact year at which each tier flips, both sides of
every resignation cliff, the UAE cap, and the Iqama tier edges — the places
where an off-by-one costs an employee real money.

---

## Assumptions and limitations

**BambooHR is a trial account with US sample data.** A handful of employees
were edited into the four operating countries to exercise the rules. The rest
resolve as `unsupported_country` and are refused rather than guessed at, which
is the correct behaviour but means the directory is not representative.

**Iqama number and expiry are BambooHR custom fields**, not native ones. Field
aliases are configurable because they differ per account.

**Time-off type IDs are hardcoded** as `1`/`2`/`3` for annual, sick and unpaid.
These are account-specific and would be read from
`/v1/meta/time_off/types` in production.

**BambooHR returns a created request's ID in the `Location` header**, not the
response body — `submitTimeOff` parses it from there. This is undocumented and
was found by inspection.

**The Sheets endpoint is open to anyone holding the URL.** Acceptable for a
demo dashboard of mock data; production needs a shared secret in the payload or
a service account.

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

---

## What I would do next

1. **Read time-off types from the API** rather than hardcoding IDs.
2. **Webhook on BambooHR approval** so the agent notifies the employee when a
   manager approves, instead of leaving them to check.
3. **Nitaqat / Saudization reporting** — named in the brief, out of scope for a
   time-boxed build, and the natural next workflow given the Riyadh HQ.
4. **The remaining two workflows** — SOP request handling as a full workflow,
   and Daily Performance Management.
5. **Harden the Sheets endpoint**, or move to a service account once there is
   somewhere to keep the key.
6. **Real SOP ingestion** — the current knowledge base is eight documents; a
   50,000-person group has hundreds, and the `SOPGaps` log is the right input
   for prioritising which to load first.
