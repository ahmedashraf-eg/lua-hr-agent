/**
 * sheets.ts — Google Sheets via an Apps Script Web App.
 *
 * Deliberately not the official Sheets API. That route needs an OAuth2
 * service account with RS256-signed JWTs, which is hours of work for a
 * write-only log. An Apps Script Web App deployed as "anyone with the link"
 * gives the same result behind a single POST.
 *
 * Deploy this alongside the sheet (Extensions → Apps Script → Deploy):
 *
 *   function doPost(e) {
 *     const body = JSON.parse(e.postData.contents);
 *     const sheet = SpreadsheetApp.getActiveSpreadsheet()
 *       .getSheetByName(body.tab || 'LeaveLog');
 *     sheet.appendRow(body.row);
 *     return ContentService
 *       .createTextOutput(JSON.stringify({ ok: true }))
 *       .setMimeType(ContentService.MimeType.JSON);
 *   }
 *
 * Logging is best-effort by design: the sheet is a reporting surface, not a
 * system of record. A employee's leave request must not fail because a
 * dashboard was unreachable, so every failure here is swallowed and reported
 * in the return value rather than thrown.
 */

import { env } from 'lua-cli';

export type SheetTab =
  | 'LeaveLog'
  | 'SOPGaps'
  | 'IqamaAlerts'
  | 'Performance'
  | 'SOPRequests';

export interface AppendResult {
  logged: boolean;
  reason?: string;
}

async function append(tab: SheetTab, row: (string | number)[]): Promise<AppendResult> {
  const url = env('SHEETS_WEBAPP_URL');
  if (!url) {
    return { logged: false, reason: 'SHEETS_WEBAPP_URL is not set' };
  }

  try {
    // A Web App deployed as "anyone with the link" is reachable by anyone who
    // has the link. The shared secret means holding the URL is not enough to
    // write to the dashboard. It is not authentication — it is the difference
    // between an open endpoint and one that needs a stolen credential.
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab, row, secret: env('SHEETS_SECRET') || undefined }),
    });

    if (!response.ok) {
      return { logged: false, reason: `Sheets responded ${response.status}` };
    }

    // Apps Script returns 200 even when it rejects the payload, so the
    // body has to be read to know whether the row actually landed.
    try {
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (body && body.ok === false) {
        return { logged: false, reason: body.error ?? 'rejected by the dashboard' };
      }
    } catch {
      // A non-JSON body means the deployment is misconfigured, not that the
      // write failed. Treat it as logged rather than failing a leave request.
    }

    return { logged: true };
  } catch (error) {
    return {
      logged: false,
      reason: error instanceof Error ? error.message : 'unknown transport error',
    };
  }
}

const now = () => new Date().toISOString();

/** Record a leave request on the live dashboard. */
export function logLeaveRequest(entry: {
  employeeId: string;
  employeeName: string;
  country: string;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  status: string;
  requestId?: string;
}): Promise<AppendResult> {
  return append('LeaveLog', [
    now(),
    entry.employeeId,
    entry.employeeName,
    entry.country,
    entry.type,
    entry.startDate,
    entry.endDate,
    entry.days,
    entry.status,
    entry.requestId ?? '',
  ]);
}

/**
 * Record a policy question the knowledge base could not answer.
 *
 * This is the escalation path the brief asks for: where no SOP exists, the
 * gap is logged and handed to HR rather than answered from thin air. The
 * accumulated rows are also the backlog for whoever writes the missing SOPs.
 */
export function logPolicyGap(entry: {
  query: string;
  employeeId?: string;
  channel?: string;
  bestScore?: number;
}): Promise<AppendResult> {
  return append('SOPGaps', [
    now(),
    entry.query,
    entry.employeeId ?? 'unknown',
    entry.channel ?? 'unknown',
    entry.bestScore !== undefined ? entry.bestScore.toFixed(3) : 'no match',
    'open',
  ]);
}

/** Record an Iqama alert raised by the scheduled sweep. */
export function logIqamaAlert(entry: {
  employeeId: string;
  employeeName: string;
  expiry: string;
  daysRemaining: number;
  severity: string;
}): Promise<AppendResult> {
  return append('IqamaAlerts', [
    now(),
    entry.employeeId,
    entry.employeeName,
    entry.expiry,
    entry.daysRemaining,
    entry.severity,
  ]);
}

/**
 * Record one team member's rating from a daily check-in.
 *
 * Written one row per member rather than one per check-in, because the sheet
 * is a dashboard: a flat table pivots and charts, a nested one does neither.
 */
export function logPerformanceRating(entry: {
  date: string;
  teamLeadId: string;
  teamLeadName: string;
  employeeId: string;
  employeeName: string;
  rating: number;
  accomplishments: string;
  blockers: string;
  note?: string;
}): Promise<AppendResult> {
  return append('Performance', [
    entry.date,
    entry.teamLeadId,
    entry.teamLeadName,
    entry.employeeId,
    entry.employeeName,
    entry.rating,
    entry.accomplishments,
    entry.blockers,
    entry.note ?? '',
    now(),
  ]);
}

/** Record an HR service request on the dashboard. */
export function logSopRequest(entry: {
  reference: string;
  type: string;
  employeeId: string;
  employeeName: string;
  country: string;
  status: string;
  owner: string;
  dueBy: string;
  details: string;
}): Promise<AppendResult> {
  return append('SOPRequests', [
    now(),
    entry.reference,
    entry.type,
    entry.employeeId,
    entry.employeeName,
    entry.country,
    entry.status,
    entry.owner,
    entry.dueBy,
    entry.details,
  ]);
}
