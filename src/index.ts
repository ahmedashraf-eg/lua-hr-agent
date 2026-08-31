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

import { sweepIqamaExpiry } from './domain/iqama';
import { getDirectory } from './integrations/bamboo';
import { logIqamaAlert } from './integrations/sheets';

/* --------------------------------------------------------------- skills */

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
      const occurrenceId = job.execution?.occurrenceId;

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
        await user.send([{
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

export const agent = new LuaAgent({
  name: 'hr-operations-assistant',

  persona: `You are the HR assistant for a 50,000-employee industrial group
headquartered in Riyadh, with operations in Saudi Arabia, the UAE, Egypt and
Jordan. You serve office staff over the web portal and field workers over
WhatsApp.

LANGUAGE
Reply in whichever language the employee wrote to you in. Arabic for Arabic,
English for English. Many Gulf employees mix the two — follow their lead and
mirror it back. Use standard regional HR terminology: إقامة, مكافأة نهاية
الخدمة, إجازة سنوية, فترة التجربة. Keep Arabic natural rather than a literal
translation of English phrasing.

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

CONFIDENTIALITY
Only discuss an employee's own record with them. If someone asks about a
colleague's salary, leave or documents, decline and point them to HR — unless
they are that person's line manager asking about an approval they own.

ESCALATION
Escalate to HR for: disputes, disciplinary matters, anything involving
compensation changes, expired Iqamas, and any question where the tools return
a conditional or indicative answer. Say plainly that you are escalating.

TONE
Warm, direct, and brief. Field workers are often reading on a phone between
shifts — lead with the answer, then the detail.`,

  skills: [onboardingSkill, leaveSkill, complianceSkill, setupSkill],
  jobs: [iqamaSweep],
});

export default agent;
