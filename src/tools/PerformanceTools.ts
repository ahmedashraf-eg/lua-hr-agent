/**
 * PerformanceTools.ts — daily check-ins and weekly team summaries.
 *
 * Workflow 4 of the brief: no system exists for this today, so the agent is
 * the system of record. Check-ins live in Lua's Data collection and are
 * mirrored to the Google Sheet, one row per team member per day, so the sheet
 * works as a live dashboard rather than a log nobody can chart.
 */

import { Data, LuaTool } from 'lua-cli';
import { z } from 'zod';

import {
  daysAgo,
  summariseTeam,
  validateCheckIn,
  withinPeriod,
  type CheckIn,
} from '../domain/performance';
import { today, toISO } from '../domain/tenure';
import { findEmployeesByName, getReports } from '../integrations/bamboo';
import { logPerformanceRating } from '../integrations/sheets';
import { check as authorize, getCaller } from './identity';

const COLLECTION = 'performance_checkins';

/** Read the collection and filter in memory. */
async function loadCheckIns(): Promise<CheckIn[]> {
  try {
    const page = await Data.get(COLLECTION, {}, 1, 100);
    return (page.data ?? []).map((entry) => entry.data as unknown as CheckIn);
  } catch {
    return [];
  }
}

export class SubmitDailyCheckinTool implements LuaTool {
  name = 'submit_daily_checkin';
  description =
    'Record a team lead’s daily check-in: what the team accomplished, any blockers, and a 1–5 productivity rating for each team member';

  inputSchema = z.object({
    date: z
      .string()
      .optional()
      .describe('Date of the check-in, YYYY-MM-DD. Defaults to today.'),
    accomplishments: z.string().describe('What the team got done today'),
    blockers: z
      .array(z.string())
      .optional()
      .default([])
      .describe('Anything holding the team up. Empty array if nothing.'),
    ratings: z
      .array(
        z.object({
          employeeId: z.string(),
          name: z.string(),
          rating: z.number().describe('Productivity rating from 1 to 5'),
          note: z.string().optional(),
        }),
      )
      .describe('One entry per team member rated today'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    // A check-in is a first-hand judgement, so the lead filing it is always
    // the caller. There is no teamLeadId input to spoof.
    const callerResult = await getCaller();
    if (!callerResult.verified) {
      return { ok: false, error: 'identity_not_verified', detail: callerResult.message, action: callerResult.action };
    }

    const { caller, employee: lead } = callerResult;

    const decision = authorize(caller, caller.employeeId, 'submit_team_checkin');
    if (!decision.allowed) {
      return {
        ok: false,
        error: `access_denied_${decision.reason}`,
        detail: decision.message,
        action: 'Explain that check-ins are filed by team leads, and offer to help with something else.',
      };
    }

    // Ratings must be for the caller's own reports. A lead cannot rate someone
    // outside their team, whether by mistake or otherwise.
    const strangers = input.ratings.filter((r) => !caller.reportIds.includes(r.employeeId));
    if (strangers.length) {
      return {
        ok: false,
        error: 'not_your_reports',
        detail: `${strangers.map((s) => s.name).join(', ')} ${strangers.length === 1 ? 'does' : 'do'} not report to you.`,
        yourReports: caller.reportIds.length,
        action: 'Tell them which names were not on their team, and ask them to re-file with only their own reports.',
      };
    }

    const date = input.date ?? toISO(today());

    const check = validateCheckIn({
      date,
      accomplishments: input.accomplishments,
      ratings: input.ratings,
    });

    if (!check.ok) {
      return {
        ok: false,
        error: check.reason,
        detail: check.message,
        offending: check.offending,
        action: 'Explain what is wrong and ask the team lead to correct it.',
      };
    }

    // A second check-in on the same day replaces the first rather than
    // double-counting — leads correct themselves, and a weekly average built
    // on duplicate entries is quietly wrong.
    const existing = await loadCheckIns();
    const duplicate = existing.find(
      (c) => c.teamLeadId === lead.id && c.date === date,
    );

    const record: CheckIn = {
      id: duplicate?.id ?? `chk-${Date.now()}`,
      teamLeadId: lead.id,
      teamLeadName: lead.displayName,
      date,
      accomplishments: input.accomplishments,
      blockers: input.blockers ?? [],
      ratings: input.ratings,
      createdAt: new Date().toISOString(),
    };

    const searchText = [
      lead.displayName,
      date,
      input.accomplishments,
      ...(input.blockers ?? []),
      ...input.ratings.map((r) => r.name),
    ].join(' ');

    let replaced = false;
    if (duplicate) {
      const page = await Data.get(COLLECTION, {}, 1, 100);
      const entry = (page.data ?? []).find(
        (e) => (e.data as { id?: string })?.id === duplicate.id,
      );
      if (entry) {
        await Data.update(COLLECTION, entry.id, record as unknown as Record<string, unknown>, searchText);
        replaced = true;
      }
    }
    if (!replaced) {
      await Data.create(COLLECTION, record as unknown as Record<string, unknown>, searchText);
    }

    // Mirror to the dashboard, one row per member. Best effort.
    let rowsLogged = 0;
    for (const rating of input.ratings) {
      const result = await logPerformanceRating({
        date,
        teamLeadId: lead.id,
        teamLeadName: lead.displayName,
        employeeId: rating.employeeId,
        employeeName: rating.name,
        rating: rating.rating,
        accomplishments: input.accomplishments,
        blockers: (input.blockers ?? []).join('; '),
        note: rating.note,
      });
      if (result.logged) rowsLogged += 1;
    }

    const lowRatings = input.ratings.filter((r) => r.rating <= 2);

    return {
      ok: true,
      checkInId: record.id,
      replacedEarlierToday: replaced,
      teamLead: lead.displayName,
      date,
      membersRated: input.ratings.length,
      blockersReported: (input.blockers ?? []).length,
      rowsWrittenToDashboard: rowsLogged,
      loggedToDashboard: rowsLogged === input.ratings.length,
      flagged: lowRatings.map((r) => ({ name: r.name, rating: r.rating })),
      agentGuidance: lowRatings.length
        ? 'Confirm the check-in was recorded, then note which members were rated 2 or below — without editorialising. The lead knows their team; your job is to surface it, not judge it.'
        : 'Confirm the check-in was recorded and how many members were rated.',
    };
  }
}

export class GetTeamSummaryTool implements LuaTool {
  name = 'get_team_summary';
  description =
    'Summarise how a team performed over a period — average ratings per member, trends, blockers and reporting rate. Use for questions like "how did Ahmad’s team perform this week?"';

  inputSchema = z.object({
    teamLead: z
      .string()
      .optional()
      .describe(
        'Omit for the caller’s own team. Supply a name or employee ID only when HR, or a manager asking about a lead who reports to them, names someone else.',
      ),
    days: z
      .number()
      .optional()
      .default(7)
      .describe('How many days back to summarise. Defaults to 7.'),
    endDate: z
      .string()
      .optional()
      .describe('End of the period, YYYY-MM-DD. Defaults to today.'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const callerResult = await getCaller();
    if (!callerResult.verified) {
      return { ok: false, error: 'identity_not_verified', detail: callerResult.message, action: callerResult.action };
    }
    const { caller } = callerResult;

    const end = input.endDate ?? toISO(today());
    const start = daysAgo(end, input.days - 1);

    // No team named means their own.
    let leadId = input.teamLead?.trim() || caller.employeeId;
    let leadName = input.teamLead?.trim() || caller.displayName;

    if (input.teamLead && !/^\d+$/.test(input.teamLead)) {
      const matches = await findEmployeesByName(input.teamLead);

      if (!matches.length) {
        return {
          ok: false,
          error: 'team_lead_not_found',
          detail: `No employee matching "${input.teamLead}" is in the directory.`,
          action: 'Ask for the team lead’s full name or employee ID.',
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          error: 'ambiguous_team_lead',
          detail: `"${input.teamLead}" matches ${matches.length} people.`,
          candidates: matches.slice(0, 5).map((m) => ({ id: m.id, name: m.displayName, jobTitle: m.jobTitle })),
          action: 'Ask which one they mean, offering the candidates by name and job title.',
        };
      }

      leadId = matches[0].id;
      leadName = matches[0].displayName;
    }

    // A summary exposes every rating that lead gave. Gate it before reading.
    if (leadId !== caller.employeeId) {
      const decision = authorize(caller, leadId, 'view_team_performance', leadName);
      if (!decision.allowed) {
        return {
          ok: false,
          error: `access_denied_${decision.reason}`,
          detail: decision.message,
          action:
            'Say you cannot share another team’s performance data, and point them to HR. Do not summarise, characterise or hint at any of it — you have not read it.',
        };
      }
    }

    const all = await loadCheckIns();
    const mine = withinPeriod(
      all.filter((c) => c.teamLeadId === leadId),
      start,
      end,
    );

    if (!mine.length) {
      const reports = await getReports(leadName);
      return {
        ok: true,
        found: false,
        teamLead: leadName,
        periodStart: start,
        periodEnd: end,
        teamSize: reports.length,
        detail: `No check-ins were submitted for ${leadName}'s team between ${start} and ${end}.`,
        agentGuidance:
          'Say plainly that nothing was submitted for this period. Do not infer performance from silence — a missing check-in is a reporting gap, not a bad week.',
      };
    }

    const summary = summariseTeam(mine, start, end, Math.min(5, input.days));
    if (!summary) {
      return { ok: false, error: 'summary_failed', detail: 'Check-ins could not be summarised.', action: 'Escalate to HR.' };
    }

    return {
      ok: true,
      found: true,
      teamLead: summary.teamLeadName,
      period: { start: summary.periodStart, end: summary.periodEnd },
      reporting: {
        checkInsSubmitted: summary.checkInsSubmitted,
        expected: summary.expectedCheckIns,
        rate: `${Math.round(summary.reportingRate * 100)}%`,
      },
      teamAverage: summary.teamAverage,
      members: summary.members,
      needingAttention: summary.membersNeedingAttention.map((m) => ({
        name: m.name,
        averageRating: m.averageRating,
        trend: m.trend,
      })),
      recurringBlockers: summary.recurringBlockers,
      agentGuidance:
        'Lead with the team average and the reporting rate, then name anyone below 2.5 and any blocker recurring across three or more days. Ratings are one lead’s judgement over a few days — present them as a prompt for a conversation, not as a verdict on someone’s performance.',
    };
  }
}
