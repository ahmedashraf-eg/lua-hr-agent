/**
 * SopRequestTools.ts — HR service requests.
 *
 * Workflow 3 of the brief. `search_policies` answers "what is the transfer
 * policy". These two tools handle the other half: an employee who wants to
 * actually make the request, and one who wants to know where it got to.
 *
 * Requests live in Lua's Data collection and mirror to the Google Sheet, so
 * HR has one queue to work from.
 */

import { Data, LuaTool } from 'lua-cli';
import { z } from 'zod';

import {
  availableRequestTypes,
  dueDate,
  makeReference,
  slaState,
  canTransition,
  validateRequest,
  type RequestType,
  type SopRequest,
} from '../domain/sopRequests';
import { today, toISO } from '../domain/tenure';
import { logSopRequest } from '../integrations/sheets';
import { resolveSubject } from './shared';
import { check as authorize, getCaller } from './identity';

const COLLECTION = 'sop_requests';

const REQUEST_TYPE = z.enum([
  'salary_certificate',
  'employment_letter',
  'transfer',
  'exit_reentry_visa',
  'iqama_renewal',
  'housing_allowance',
  'other',
]);

async function loadRequests(): Promise<Array<{ entryId: string; request: SopRequest }>> {
  try {
    const page = await Data.get(COLLECTION, {}, 1, 100);
    return (page.data ?? []).map((entry) => ({
      entryId: entry.id,
      request: entry.data as unknown as SopRequest,
    }));
  } catch {
    return [];
  }
}

export class SubmitSopRequestTool implements LuaTool {
  name = 'submit_sop_request';
  description =
    'Submit an HR service request on an employee’s behalf — salary certificate, transfer, exit and re-entry visa, housing allowance advance, and so on';

  inputSchema = z.object({
    employeeId: z.string().optional().describe('Omit this for the person you are talking to — their identity is taken from their verified account, never from the conversation. Supply it only when an HR user, or a line manager asking about their own report, names someone else.'),
    requestType: REQUEST_TYPE.describe('Which service the employee is requesting'),
    details: z
      .record(z.string(), z.string())
      .optional()
      .default({})
      .describe(
        'Details specific to the request type. If you do not know what is needed, submit with an empty object and the tool will tell you what to ask for.',
      ),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const resolved = await resolveSubject(input.employeeId, 'submit_request');
    if (!resolved.ok) return resolved;

    const { employee, rule } = resolved;

    const check = validateRequest({
      type: input.requestType,
      country: rule.code,
      details: input.details ?? {},
    });

    /* ------------------------------------------- not available here */
    if (check.reason === 'not_available_in_country') {
      return {
        ok: false,
        error: 'not_available_in_country',
        detail: check.message,
        availableInstead: availableRequestTypes(rule.code).map((s) => ({
          type: s.type,
          label: s.label,
        })),
        action:
          'Explain that this request does not apply in their country, and offer what is available instead.',
      };
    }

    if (check.reason === 'unknown_type') {
      return { ok: false, error: 'unknown_type', detail: check.message, action: 'Ask what they need.' };
    }

    /* ---------------------------------- needs more from the employee */
    if (check.reason === 'missing_details') {
      return {
        ok: false,
        error: 'missing_details',
        detail: check.message,
        requestType: check.spec!.label,
        // English only. Handing the model both languages lets the tool decide
        // what the employee reads, which is the persona's job — and in
        // practice it picks whichever it saw last rather than whichever the
        // employee wrote in.
        needed: check.missing!.map((f) => ({ field: f.key, ask: f.prompt })),
        action:
          'Ask the employee for these, translated into the language of THEIR last message, then call this tool again with them filled in. Do not invent values.',
      };
    }

    /* ------------------------------------------------------- submit */
    const spec = check.spec!;
    const submittedAt = toISO(today());
    const reference = makeReference(spec.type as RequestType);

    const request: SopRequest = {
      reference,
      type: spec.type,
      employeeId: employee.id,
      employeeName: employee.displayName,
      country: rule.code,
      status: 'submitted',
      details: input.details ?? {},
      owner: spec.owner,
      submittedAt,
      dueBy: dueDate(submittedAt, spec.slaWorkingDays),
    };

    const searchText = [
      reference,
      spec.label,
      spec.labelAr,
      employee.displayName,
      rule.name,
      ...Object.values(input.details ?? {}),
    ].join(' ');

    await Data.create(COLLECTION, request as unknown as Record<string, unknown>, searchText);

    const logged = await logSopRequest({
      reference,
      type: spec.label,
      employeeId: employee.id,
      employeeName: employee.displayName,
      country: rule.code,
      status: 'submitted',
      owner: spec.owner,
      dueBy: request.dueBy,
      details: Object.entries(input.details ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('; '),
    });

    return {
      ok: true,
      reference,
      requestType: spec.label,
      requestTypeAr: spec.labelAr,
      employeeName: employee.displayName,
      status: 'submitted',
      owner: spec.owner,
      slaWorkingDays: spec.slaWorkingDays,
      dueBy: request.dueBy,
      loggedToDashboard: logged.logged,
      relatedPolicy: spec.policyId,
      agentGuidance:
        'Give the employee the reference number and the due date, and tell them who owns it. The due date already counts working days on a Sunday-to-Thursday week, so quote it as-is.',
    };
  }
}

/**
 * Advancing a request. HR only.
 *
 * Without this, every request sat at `submitted` forever and
 * check_request_status reported the moment of filing rather than reality — a
 * status field nobody can change is worse than none, because it looks live.
 */
export class UpdateRequestStatusTool implements LuaTool {
  name = 'update_request_status';
  description =
    'Advance an HR service request — mark it in progress, waiting on the employee, completed or rejected. HR only.';

  inputSchema = z.object({
    reference: z.string().describe('The request reference, e.g. SAL-123456'),
    status: z
      .enum(['in_progress', 'awaiting_employee', 'completed', 'rejected'])
      .describe('The new status'),
    note: z
      .string()
      .optional()
      .describe('Why — shown to the employee when they next ask about the request'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const callerResult = await getCaller();
    if (!callerResult.verified) {
      return { ok: false, error: 'identity_not_verified', detail: callerResult.message, action: callerResult.action };
    }
    const { caller } = callerResult;

    if (caller.role !== 'hr') {
      return {
        ok: false,
        error: 'access_denied_requires_hr',
        detail: 'Only HR can change the status of a request.',
        action: 'Say this is something HR does, and offer to check the current status instead.',
      };
    }

    const all = await loadRequests();
    const needle = input.reference.trim().toUpperCase();
    const found = all.find((r) => r.request.reference.toUpperCase() === needle);

    if (!found) {
      return {
        ok: false,
        error: 'request_not_found',
        detail: `No request with reference ${input.reference} exists.`,
        action: 'Ask them to check the reference.',
      };
    }

    const transition = canTransition(found.request.status, input.status);
    if (!transition.ok) {
      return {
        ok: false,
        error: 'invalid_transition',
        detail: transition.message,
        currentStatus: found.request.status,
        action: 'Tell them where the request already stands.',
      };
    }

    const now = toISO(today());
    const updated: SopRequest = {
      ...found.request,
      status: input.status,
      note: input.note ?? found.request.note,
      completedAt:
        input.status === 'completed' || input.status === 'rejected' ? now : found.request.completedAt,
    };

    await Data.update(
      COLLECTION,
      found.entryId,
      updated as unknown as Record<string, unknown>,
    );

    // A second dashboard row rather than an edit — Apps Script appends, and an
    // append-only trail is the more useful artefact for HR anyway.
    const logged = await logSopRequest({
      reference: updated.reference,
      type: updated.type,
      employeeId: updated.employeeId,
      employeeName: updated.employeeName,
      country: updated.country,
      status: updated.status,
      owner: updated.owner,
      dueBy: updated.dueBy,
      details: input.note ? `status change: ${input.note}` : 'status change',
    });

    const sla = slaState(updated, now);

    return {
      ok: true,
      reference: updated.reference,
      previousStatus: found.request.status,
      status: updated.status,
      employeeName: updated.employeeName,
      changedBy: caller.displayName,
      withinSla: !sla.breached,
      loggedToDashboard: logged.logged,
      agentGuidance:
        input.status === 'completed' && sla.breached
          ? 'Confirm the change, and note that this one closed past its SLA so it shows in the overdue count.'
          : 'Confirm the change and offer to notify the employee.',
    };
  }
}

export class CheckRequestStatusTool implements LuaTool {
  name = 'check_request_status';
  description =
    'Check the status of an HR service request, by reference number or by employee';

  inputSchema = z.object({
    reference: z
      .string()
      .optional()
      .describe('The request reference, e.g. SAL-123456'),
    employeeId: z
      .string()
      .optional()
      .describe(
        'Omit to list the requests of the person you are talking to. Supply it only when HR, or a line manager asking about their own report, names someone else.',
      ),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    // A reference number is guessable, so it is not on its own a licence to
    // read a request. Establish the caller first, then decide.
    const callerResult = await getCaller();
    if (!callerResult.verified) {
      return {
        ok: false,
        error: 'identity_not_verified',
        detail: callerResult.message,
        action: callerResult.action,
      };
    }
    const { caller } = callerResult;

    const all = await loadRequests();
    const asOf = toISO(today());

    /* --------------------------------------------- single reference */
    if (input.reference) {
      const needle = input.reference.trim().toUpperCase();
      const found = all.find((r) => r.request.reference.toUpperCase() === needle);

      if (!found) {
        return {
          ok: false,
          error: 'request_not_found',
          detail: `No request with reference ${input.reference} exists.`,
          action: 'Ask them to double-check the reference, or offer to list all their open requests.',
        };
      }

      const decision = authorize(caller, found.request.employeeId, 'view_record', found.request.employeeName);
      if (!decision.allowed) {
        // Same wording as a missing reference. Distinguishing the two would
        // confirm that a reference exists, which is itself a disclosure.
        return {
          ok: false,
          error: 'request_not_found',
          detail: `No request with reference ${input.reference} is available to you.`,
          action: 'Ask them to double-check the reference, or offer to list their own open requests.',
        };
      }

      const sla = slaState(found.request, asOf);

      return {
        ok: true,
        reference: found.request.reference,
        requestType: found.request.type,
        employeeName: found.request.employeeName,
        status: found.request.status,
        owner: found.request.owner,
        submittedAt: found.request.submittedAt,
        dueBy: sla.dueBy,
        overdue: sla.breached,
        workingDaysRemaining: sla.workingDaysRemaining,
        agentGuidance: sla.breached
          ? 'This request is past its SLA. Say so plainly, apologise once, and escalate to the owning team rather than asking the employee to wait longer.'
          : 'Give the status, who has it, and how many working days remain.',
      };
    }

    /* -------------------------------------------- all for employee */
    const targetId = input.employeeId?.trim() || caller.employeeId;

    if (targetId !== caller.employeeId) {
      const decision = authorize(caller, targetId, 'view_record');
      if (!decision.allowed) {
        return {
          ok: false,
          error: `access_denied_${decision.reason}`,
          detail: decision.message,
          action: 'Say you cannot share another person’s requests, and point them to HR.',
        };
      }
    }

    const mine = all
      .filter((r) => r.request.employeeId === targetId)
      .map((r) => ({ ...r.request, sla: slaState(r.request, asOf) }))
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

    if (!mine.length) {
      return {
        ok: true,
        found: false,
        employeeId: targetId,
        detail: 'This employee has no HR service requests on record.',
        agentGuidance: 'Tell them nothing is open, and offer to submit something if they need it.',
      };
    }

    return {
      ok: true,
      found: true,
      employeeId: targetId,
      count: mine.length,
      open: mine.filter((r) => r.status !== 'completed' && r.status !== 'rejected').length,
      overdue: mine.filter((r) => r.sla.breached && r.status !== 'completed').length,
      requests: mine.map((r) => ({
        reference: r.reference,
        type: r.type,
        status: r.status,
        owner: r.owner,
        submittedAt: r.submittedAt,
        dueBy: r.dueBy,
        overdue: r.sla.breached,
      })),
      agentGuidance: 'Lead with anything overdue, then anything open, then completed.',
    };
  }
}
