/**
 * LeaveTools.ts — leave balance and leave requests.
 *
 * The request tool writes to BambooHR first and the Google Sheet second.
 * That order matters: BambooHR is the system of record and the sheet is a
 * reporting surface, so a dashboard outage must never lose a leave request.
 */

import { LuaTool } from 'lua-cli';
import { z } from 'zod';

import { balance, entitlements, validateLeaveRequest, type LeaveRecord, type LeaveType } from '../domain/leave';
import { getTimeOffRequests, submitTimeOff } from '../integrations/bamboo';
import { logLeaveRequest } from '../integrations/sheets';
import { currentChannel, resolveEmployee } from './shared';

import { env } from 'lua-cli';

const LEAVE_TYPE = z.enum(['annual', 'sick', 'unpaid']);

/** BambooHR time-off type IDs differ per account; override via env if needed. */
const TIME_OFF_TYPE_IDS: Record<LeaveType, string> = {
  annual: env('BAMBOOHR_TIME_OFF_ANNUAL_ID') || '78',
  sick: env('BAMBOOHR_TIME_OFF_SICK_ID') || '79',
  unpaid: env('BAMBOOHR_TIME_OFF_UNPAID_ID') || '83',
};

/** Map BambooHR's time-off requests onto the domain's record shape. */
async function loadRecords(employeeId: string): Promise<LeaveRecord[]> {
  const requests = await getTimeOffRequests(employeeId);

  return requests.map((r) => {
    const status = r.status?.toString().toLowerCase() ?? 'pending';
    return {
      id: String(r.id),
      employeeId,
      type: (r.type?.toString().toLowerCase().includes('sick')
        ? 'sick'
        : r.type?.toString().toLowerCase().includes('unpaid')
          ? 'unpaid'
          : 'annual') as LeaveType,
      startDate: r.start,
      endDate: r.end,
      days: Number(r.amount?.amount ?? 0),
      status: (status === 'approved'
        ? 'approved'
        : status === 'denied' || status === 'rejected'
          ? 'rejected'
          : status === 'cancelled'
            ? 'cancelled'
            : 'pending') as LeaveRecord['status'],
      createdAt: r.start,
    };
  });
}

export class CheckLeaveBalanceTool implements LuaTool {
  name = 'check_leave_balance';
  description =
    'Check an employee’s remaining annual or sick leave, using their country’s statutory entitlement';

  inputSchema = z.object({
    employeeId: z.string().describe('The BambooHR employee ID'),
    leaveType: LEAVE_TYPE.optional().default('annual'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const resolved = await resolveEmployee(input.employeeId);
    if (!resolved.ok) return resolved;

    const { employee, rule } = resolved;
    const records = await loadRecords(employee.id);
    const leaveType: LeaveType = input.leaveType || 'annual';

    const bal = balance(rule.code, employee.hireDate, leaveType, records);
    const ent = entitlements(rule.code, employee.hireDate);
    if (!bal || !ent) {
      return {
        ok: false,
        error: 'unsupported_country',
        detail: `No leave rules are configured for ${rule.name}.`,
        action: 'Escalate to HR.',
      };
    }

    if (leaveType === 'unpaid') {
      return {
        ok: true,
        employeeId: employee.id,
        employeeName: employee.displayName,
        country: rule.code,
        leaveType: 'unpaid',
        note: 'Unpaid leave has no statutory cap but is never granted automatically — it needs HR approval.',
        source: bal.source,
      };
    }

    return {
      ok: true,
      employeeId: employee.id,
      employeeName: employee.displayName,
      country: rule.code,
      leaveType,
      entitlementDays: bal.entitlement,
      takenOrPendingDays: bal.reserved,
      remainingDays: bal.remaining,
      // Surfaced so the agent can explain a graduated sick-leave year rather
      // than quoting a single misleading total.
      sickLeaveTiers: leaveType === 'sick' ? ent.sickTiers : undefined,
      source: bal.source,
    };
  }
}

export class RequestLeaveTool implements LuaTool {
  name = 'request_leave';
  description =
    'Submit a leave request for an employee after checking it against their balance and country rules';

  inputSchema = z.object({
    employeeId: z.string().describe('The BambooHR employee ID'),
    leaveType: LEAVE_TYPE.describe('annual, sick or unpaid'),
    startDate: z.string().describe('First day of leave, YYYY-MM-DD'),
    endDate: z.string().describe('Last day of leave, YYYY-MM-DD'),
    note: z.string().optional().describe('Optional note from the employee'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const resolved = await resolveEmployee(input.employeeId);
    if (!resolved.ok) return resolved;

    const { employee, rule } = resolved;
    const records = await loadRecords(employee.id);

    const check = validateLeaveRequest({
      country: rule.code,
      hireDate: employee.hireDate,
      type: input.leaveType,
      startDate: input.startDate,
      endDate: input.endDate,
      records,
    });

    if (!check.ok) {
      return {
        ok: false,
        error: check.reason,
        detail: check.message,
        requestedDays: check.days,
        remainingDays: check.remaining,
        action:
          check.reason === 'insufficient_balance'
            ? 'Tell the employee how many days remain and offer to submit a shorter request.'
            : 'Explain the problem and ask for corrected details.',
      };
    }

    const submission = await submitTimeOff({
      employeeId: employee.id,
      start: input.startDate,
      end: input.endDate,
      timeOffTypeId: TIME_OFF_TYPE_IDS[input.leaveType],
      amount: check.days!,
      note: input.note,
    });

    // Best-effort dashboard write. Never blocks the request.
    const logged = await logLeaveRequest({
      employeeId: employee.id,
      employeeName: employee.displayName,
      country: rule.code,
      type: input.leaveType,
      startDate: input.startDate,
      endDate: input.endDate,
      days: check.days!,
      status: 'pending',
      requestId: submission.id,
    });

    return {
      ok: true,
      requestId: submission.id,
      status: 'pending_approval',
      employeeId: employee.id,
      employeeName: employee.displayName,
      leaveType: input.leaveType,
      startDate: input.startDate,
      endDate: input.endDate,
      days: check.days,
      remainingAfterRequest: check.remaining,
      requiresManagerApproval: true,
      loggedToDashboard: logged.logged,
      note: check.requiresApproval
        ? 'Unpaid leave has been submitted and needs explicit HR approval.'
        : 'Submitted to the line manager for approval.',
    };
  }
}
