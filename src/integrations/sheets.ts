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

export type SheetTab = 'LeaveLog' | 'SOPGaps' | 'IqamaAlerts';

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
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab, row }),
    });

    if (!response.ok) {
      return { logged: false, reason: `Sheets responded ${response.status}` };
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
