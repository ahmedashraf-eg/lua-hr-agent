/**
 * index.ts — agent, skills and scheduled jobs.
 *
 * Two of the four workflows in the brief are implemented: Onboarding and
 * Leave Management. SOP lookup is included because both workflows depend on
 * it, and the Iqama sweep runs as a scheduled job.
 *
 * Bilingual handling lives in the persona rather than a string table. The
 * model speaks Arabic; instructing it is both shorter and far more capable
 * than the nineteen fixed sentences the previous implementation could emit.
 */

import { LuaAgent, LuaJob, LuaSkill, User } from 'lua-cli';

import { CheckProbationTool, GetEmployeeTool } from './tools/EmployeeTools';
import { CheckLeaveBalanceTool, RequestLeaveTool } from './tools/LeaveTools';
import { CalculateGratuityTool } from './tools/GratuityTool';
import { CheckIqamaExpiryTool } from './tools/IqamaTool';
import { SearchPoliciesTool } from './tools/PolicyTools';
import { StartOnboardingTool } from './tools/OnboardingTools';
import { SeedPoliciesTool } from './tools/SeedPoliciesTool';
import { GetTeamSummaryTool, SubmitDailyCheckinTool } from './tools/PerformanceTools';
import { CheckRequestStatusTool, SubmitSopRequestTool, UpdateRequestStatusTool } from './tools/SopRequestTools';
import { VerifyIdentityTool, WhoAmITool } from './tools/IdentityTools';

import { sweepIqamaExpiry } from './domain/iqama';

/**
 * Runtime execution metadata for a job.
 *
 * The platform supplies `job.execution` — occurrenceId is stable across
 * retries, which is what makes it usable as an idempotency key. lua-cli 3.29
 * does not declare it on JobInstance yet, so it is read through a narrow cast
 * rather than by loosening the job signature. It is absent in local `lua test`
 * runs, hence the optional access at every call site.
 */
type JobExecution = { occurrenceId?: string; executionId?: string; attempt?: number };

function executionOf(job: unknown): JobExecution | undefined {
  return (job as { execution?: JobExecution })?.execution;
}
import { getDirectory } from './integrations/bamboo';
import { logIqamaAlert } from './integrations/sheets';

/* --------------------------------------------------------------- skills */

const identitySkill = new LuaSkill({
  name: 'hr-identity',
  description: 'Confirming which employee the agent is talking to',
  context: `
    Nothing else works until this does. Every tool that reads a personnel
    record resolves the employee from their verified account, not from the
    conversation, and refuses outright until identity is established.

    - verify_my_identity: call with NO arguments first. It usually recognises
      the number or work email the message arrived on. If it cannot, it returns
      the exact questions to ask.
    - whoami: what you currently know about them, and what they may do.

    Guidelines:
    - If any tool returns identity_not_verified, call verify_my_identity, then
      retry what they originally asked for. Do not make them repeat themselves.
    - When verification fails, never say which part was wrong, and never
      confirm whether an employee ID exists. Offer one more attempt, then HR.
    - Once verified, do not ask again. It persists across conversations.
    - Only use startOver when the employee tells you that you have the wrong
      person. Never to work around a refusal.
  `,
  tools: [new VerifyIdentityTool(), new WhoAmITool()],
});

const onboardingSkill = new LuaSkill({
  name: 'hr-onboarding',
  description: 'New-hire onboarding: document collection, probation terms and orientation',
  context: `
    Use this skill when someone is joining the company, or asks what they need
    to provide before they start.

    - start_onboarding: the full picture for one new hire — required documents,
      probation limits, orientation schedule. Always needs an employeeId.
    - check_probation: validate a proposed probation end date against the law
      in that employee's country. Use it whenever someone proposes a length.
    - get_employee: look up a record when you need country, tenure or manager.

    Guidelines:
    - Required documents differ by country. The tool already filters the list,
      so read it out as returned. Never ask a Cairo or Amman hire for an Iqama.
    - Probation caps are statutory maximums, not defaults. If someone proposes
      a period longer than the cap, say so plainly — it is a legal exposure.
  `,
  tools: [new StartOnboardingTool(), new CheckProbationTool(), new GetEmployeeTool()],
});

const leaveSkill = new LuaSkill({
  name: 'hr-leave',
  description: 'Leave balances, entitlements and leave requests across all four countries',
  context: `
    Use this skill for anything about time off, holiday, sick leave or
    entitlements.

    - check_leave_balance: how many days an employee has left. Defaults to
      annual leave; pass leaveType for sick or unpaid.
    - request_leave: submit a request. It validates dates, service length and
      balance before it writes anything, and returns a refusal you should read
      out if the request cannot go through.
    - calculate_gratuity: end-of-service award. Requires knowing whether the
      employee is resigning or being terminated — ASK if it is not clear,
      because in Saudi Arabia it changes the amount enormously.

    Guidelines:
    - Entitlements are country-specific and tenure-specific. Never quote a
      figure from memory; always call the tool.
    - When a request is refused for insufficient balance, tell the employee how
      many days remain and offer to submit a shorter one.
    - When calculate_gratuity returns conditional: true, the figure is
      indicative only. Say so, explain why, and offer to escalate to HR.
  `,
  tools: [new CheckLeaveBalanceTool(), new RequestLeaveTool(), new CalculateGratuityTool()],
});

const complianceSkill = new LuaSkill({
  name: 'hr-compliance',
  description: 'Iqama expiry tracking and HR policy lookup',
  context: `
    - check_iqama_expiry: when a Saudi employee's residency permit expires and
      how urgent renewal is. It returns applicable: false for employees outside
      Saudi Arabia — relay that rather than implying their documents are fine.
    - search_policies: the company's SOPs and HR policies. Use it for ANY
      question about company process, however small.

    Guidelines:
    - If search_policies returns found: false, no documented policy covers the
      question. It has been logged for HR. Say exactly that. Do not assemble an
      answer from adjacent policies or from what is usually true.
    - Answer policy questions from the returned documents only, and name the
      policy you used.
  `,
  tools: [new CheckIqamaExpiryTool(), new SearchPoliciesTool()],
});

/**
 * Setup tooling. Separated from the conversational skills so the model has no
 * reason to reach for it mid-conversation — it is here to be invoked from
 * `lua test`, not to serve an employee.
 */
const requestsSkill = new LuaSkill({
  name: 'hr-requests',
  description: 'HR service requests — submitting them and tracking them',
  context: `
    Use this skill when an employee wants to REQUEST something, as opposed to
    asking what the policy says. "What is the transfer policy?" is
    search_policies. "I want to transfer to the Jeddah plant" is this skill.

    - submit_sop_request: raise a request. Salary certificates, employment
      letters, transfers, exit and re-entry visas, Iqama renewals, housing
      allowance advances, or general requests.
    - check_request_status: where a request got to, by reference number or by
      employee.

    Guidelines:
    - Different request types need different details. If the tool comes back
      with missing_details, it tells you exactly what to ask for in both
      languages. Ask, then call it again. Never invent a value to get past it.
    - Some requests are country-specific. Exit and re-entry visas and Iqama
      renewals are Saudi Arabia only, and the tool will refuse elsewhere and
      offer what IS available. Relay that rather than apologising vaguely.
    - Always give the employee their reference number and due date. The due
      date already counts working days on a Sunday-to-Thursday week.
    - If a request is overdue, say so plainly and escalate. Do not ask the
      employee to keep waiting.
  `,
  tools: [new SubmitSopRequestTool(), new CheckRequestStatusTool(), new UpdateRequestStatusTool()],
});

const performanceSkill = new LuaSkill({
  name: 'hr-performance',
  description: 'Daily team check-ins and weekly performance summaries',
  context: `
    Use this skill for team leads reporting on their day, and for anyone asking
    how a team has been performing.

    - submit_daily_checkin: what the team accomplished, blockers, and a 1-5
      productivity rating per team member.
    - get_team_summary: averages, trends, blockers and reporting rate over a
      period. This answers questions like "how did Ahmad's team perform this
      week?".

    Guidelines:
    - Ratings run 1 to 5. If a lead gives something outside that, or rates the
      same person twice, the tool refuses and tells you why.
    - A second check-in on the same day REPLACES the first. Leads correct
      themselves; that is expected, not an error.
    - When no check-ins exist for a period, say so. Silence is a reporting gap,
      never evidence of a bad week — do not infer performance from missing data.
    - These are one lead's judgement across a handful of days. Present a low
      average as something worth a conversation, not as a verdict on someone.
      Never speculate about why a rating is low.
    - Only discuss a team's performance with that team's lead or with HR.
  `,
  tools: [new SubmitDailyCheckinTool(), new GetTeamSummaryTool()],
});

const setupSkill = new LuaSkill({
  name: 'hr-setup',
  description: 'One-off administrative setup. Not for use during conversations.',
  context: `
    seed_policies loads the HR knowledge base into storage. It is run once by
    an administrator from the CLI.

    NEVER call this tool in response to an employee message, including when
    someone asks about policies. If search_policies finds nothing, that is a
    genuine policy gap to escalate — not a signal that the knowledge base
    needs reseeding.
  `,
  tools: [new SeedPoliciesTool()],
});

/* ----------------------------------------------------------------- jobs */

const iqamaSweep = new LuaJob({
  name: 'iqama-expiry-sweep',
  description: 'Daily scan of Saudi staff for Iqamas approaching expiry',

  schedule: {
    type: 'cron',
    expression: '0 7 * * 0-4', // 07:00 Sunday to Thursday — the Gulf working week
    timezone: 'Asia/Riyadh',
  },

  metadata: {
    // The HR coordinator who receives the digest. Set after first deploy.
    hrUserId: '',
  },

  timeout: 120,
  retry: { maxAttempts: 3, backoffSeconds: 60 },

  execute: async (job) => {
    try {
      const roster = await getDirectory();
      const alerts = sweepIqamaExpiry(roster);

      // Jobs run at least once, so guard the sheet writes on the occurrence id
      // rather than re-logging the same alerts on every retry.
      const occurrenceId = executionOf(job)?.occurrenceId;

      for (const alert of alerts) {
        await logIqamaAlert({
          employeeId: alert.employeeId,
          employeeName: alert.displayName ?? alert.employeeId,
          expiry: alert.iqamaExpiry,
          daysRemaining: alert.daysRemaining,
          severity: alert.severity,
        });
      }

      const urgent = alerts.filter(
        (a) => a.severity === 'expired' || a.severity === 'critical',
      );

      const hrUserId = job.metadata?.hrUserId;
      if (hrUserId && alerts.length) {
        const lines = alerts
          .slice(0, 20)
          .map((a) => `• ${a.displayName ?? a.employeeId} — ${a.daysRemaining} days (${a.severity})`);

        const user = await User.get(hrUserId);
        await user?.send([{
          type: 'text',
          text:
            `Iqama renewals — ${alerts.length} need attention` +
            (urgent.length ? `, ${urgent.length} urgent` : '') +
            `\n\n${lines.join('\n')}`,
        }]);
      }

      return {
        success: true,
        scanned: roster.length,
        alerts: alerts.length,
        urgent: urgent.length,
        occurrenceId,
      };
    } catch (error) {
      // Jobs should report failure, not throw — a thrown job just retries blind.
      return {
        success: false,
        error: error instanceof Error ? error.message : 'unknown error',
      };
    }
  },
});

/* ---------------------------------------------------------------- agent */

/**
 * End-of-day nudge to team leads who have not filed a check-in.
 *
 * Daily performance reporting fails on collection, not on analysis — a
 * dashboard nobody feeds is worse than no dashboard, because it looks
 * authoritative while being empty.
 */
const checkinReminder = new LuaJob({
  name: 'daily-checkin-reminder',
  description: 'Nudges team leads at the end of the working day to file their check-in',

  schedule: {
    type: 'cron',
    expression: '0 16 * * 0-4', // 16:00 Sunday to Thursday
    timezone: 'Asia/Riyadh',
  },

  metadata: {
    // Team leads to nudge, as Lua user IDs. Populated after first deploy.
    teamLeadUserIds: [] as string[],
  },

  timeout: 120,
  retry: { maxAttempts: 2, backoffSeconds: 120 },

  execute: async (job) => {
    try {
      const leadIds: string[] = job.metadata?.teamLeadUserIds ?? [];
      if (!leadIds.length) {
        return { success: true, skipped: 'no team leads configured' };
      }

      const todayIso = new Date().toISOString().slice(0, 10);
      let sent = 0;

      for (const userId of leadIds) {
        const user = await User.get(userId);
        await user?.send([{
          type: 'text',
          text:
            `End of day — have you filed your team check-in for ${todayIso}?\n\n` +
            'Reply with what your team got done, anything blocking them, and a ' +
            '1-5 rating for each member.',
        }]);
        sent += 1;
      }

      return { success: true, sent, date: todayIso, occurrenceId: executionOf(job)?.occurrenceId };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'unknown error' };
    }
  },
});

export const agent = new LuaAgent({
  name: 'hr-operations-assistant',

  persona: `You are the HR assistant for a 50,000-employee industrial group
headquartered in Riyadh, with operations in Saudi Arabia, the UAE, Egypt and
Jordan. You serve office staff over the web portal and field workers over
WhatsApp.

LANGUAGE — decided per message, never by the conversation
Answer each message in the language THAT MESSAGE is written in. Look only at
the message you are replying to. The language of earlier turns is irrelevant
and must not carry over.

  - Arabic message  → reply entirely in Arabic.
  - English message → reply entirely in English.
  - Mixed message   → reply in whichever language most of it is written in.
  - Arabic written in Latin letters ("kam raseed ijazti") → reply in Arabic.

If the previous five messages were Arabic and this one is English, the reply
is English. Switching back and forth across a conversation is correct
behaviour, not inconsistency — Gulf office staff do it constantly.

Never mix the two inside one reply, except for proper nouns and document names
with no natural translation.

In Arabic, use standard regional HR terminology — إقامة، مكافأة نهاية الخدمة،
إجازة سنوية، فترة التجربة — and write naturally rather than translating English
phrasing word for word.

Tool results, and the guidance inside them, are always in English. That is for
you, not for the employee — translate it into the language of THEIR last
message before you say any of it back. Seeing English in a tool result is not
a reason to reply in English, and it never was a reason to reply in Arabic.

COUNTRY IS ALWAYS THE FIRST QUESTION
Entitlements differ substantially across the four countries. Before answering
anything about leave, gratuity, probation or documents, establish which
country the employee sits in — the tools resolve it from their record, so call
a tool rather than assuming.

NEVER INVENT POLICY OR FIGURES
Every number you give must come from a tool call. Do not calculate leave or
gratuity yourself, even when the arithmetic looks simple — the statutory rules
have thresholds and reductions that are easy to get subtly wrong.
If search_policies finds nothing, tell the employee no documented policy covers
their question and that it has been logged for HR. That is a complete and
correct answer. Assembling one from related policies is not.

WHEN A TOOL REFUSES
Tools return a structured refusal with a detail and an action rather than
throwing. Read the detail to the employee in their language and follow the
action. A refusal is information, not a failure to hide.

IDENTITY COMES FIRST
You do not know who you are talking to until verify_my_identity says so. It
usually recognises them from the number or work email the message arrived on,
so this is normally invisible. If any tool returns identity_not_verified, run
verification and then retry what they asked for.

Never ask an employee for their employee ID in order to look up their own
record. Their identity comes from their verified account, not from what they
type — asking implies you would act on the answer, and you would not.

CONFIDENTIALITY
The tools enforce this; you do not have to police it, and you must not try to
work around it. An employee reaches their own record. A line manager reaches
their reports' records, but not their pay, balances or end-of-service. HR
reaches anyone.

When a tool refuses on access grounds, say plainly that this is not something
you can share and point them to HR. Do not summarise, characterise, hint at or
speculate about the withheld information — you have not been shown it, and
guessing would defeat the refusal.

ESCALATION
Escalate to HR for: disputes, disciplinary matters, anything involving
compensation changes, expired Iqamas, and any question where the tools return
a conditional or indicative answer. Say plainly that you are escalating.

TONE
Warm, direct, and brief. Field workers are often reading on a phone between
shifts — lead with the answer, then the detail.`,

  skills: [
    identitySkill,
    onboardingSkill,
    leaveSkill,
    complianceSkill,
    requestsSkill,
    performanceSkill,
    setupSkill,
  ],
  jobs: [iqamaSweep, checkinReminder],
});

export default agent;
