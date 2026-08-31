/**
 * Code.gs — Google Sheets write endpoint for the HR agent.
 *
 * Deliberately an Apps Script Web App rather than the Sheets REST API. The
 * official route needs an OAuth2 service account with RS256-signed JWTs,
 * which is hours of work to support a write-only log. This is the same
 * result behind one POST.
 *
 * ── Setup ─────────────────────────────────────────────────────────────
 *  1. Create a Google Sheet named "HR Agent — Live Dashboard".
 *  2. Extensions → Apps Script. Replace the default file with this one.
 *  3. Run `setup` once from the editor and approve the permission prompt.
 *     That creates the three tabs with frozen, formatted headers.
 *  4. Deploy → New deployment → Web app.
 *       Execute as:       Me
 *       Who has access:   Anyone
 *  5. Copy the /exec URL into the agent's .env as SHEETS_WEBAPP_URL.
 *  6. Share the sheet read-only and put that link in the README — it is the
 *     live dashboard the brief asks for.
 *
 * "Anyone" means anyone holding the URL can append rows. That is acceptable
 * for a demo dashboard holding mock data. For production, put a shared secret
 * in the payload and check it in doPost, or move to a service account.
 */

var TABS = {
  LeaveLog: [
    'Timestamp', 'Employee ID', 'Employee', 'Country', 'Leave Type',
    'Start Date', 'End Date', 'Days', 'Status', 'BambooHR Request ID',
  ],
  SOPGaps: [
    'Timestamp', 'Question Asked', 'Employee ID', 'Channel',
    'Best Match Score', 'Status',
  ],
  IqamaAlerts: [
    'Timestamp', 'Employee ID', 'Employee', 'Iqama Expiry',
    'Days Remaining', 'Severity',
  ],
};

var HEADER_BACKGROUND = '#1b6b52';
var HEADER_FOREGROUND = '#ffffff';

/**
 * Run once from the Apps Script editor. Creates any missing tab and applies
 * header formatting. Safe to re-run — it never touches existing data rows.
 */
function setup() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(TABS).forEach(function (tabName) {
    var sheet = spreadsheet.getSheetByName(tabName);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(tabName);
    }

    var headers = TABS[tabName];
    var headerRange = sheet.getRange(1, 1, 1, headers.length);

    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground(HEADER_BACKGROUND);
    headerRange.setFontColor(HEADER_FOREGROUND);

    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
  });

  // Remove the default empty sheet Google creates with every new spreadsheet.
  var leftover = spreadsheet.getSheetByName('Sheet1');
  if (leftover && spreadsheet.getSheets().length > 1) {
    spreadsheet.deleteSheet(leftover);
  }

  Logger.log('Setup complete: ' + Object.keys(TABS).join(', '));
}

/**
 * Append handler. Expects { tab: string, row: array }.
 * Always returns JSON so a failure is visible in the agent's return value
 * rather than surfacing as an opaque HTML error page.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'Empty request body' });
    }

    var body = JSON.parse(e.postData.contents);
    var tabName = body.tab || 'LeaveLog';
    var row = body.row;

    if (!Object.prototype.hasOwnProperty.call(TABS, tabName)) {
      return json({ ok: false, error: 'Unknown tab: ' + tabName });
    }
    if (!Array.isArray(row)) {
      return json({ ok: false, error: 'row must be an array' });
    }

    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = spreadsheet.getSheetByName(tabName);

    // Self-heal if someone deleted a tab after setup ran.
    if (!sheet) {
      sheet = spreadsheet.insertSheet(tabName);
      sheet.appendRow(TABS[tabName]);
      sheet.setFrozenRows(1);
    }

    sheet.appendRow(row);

    return json({ ok: true, tab: tabName, rowNumber: sheet.getLastRow() });
  } catch (error) {
    return json({ ok: false, error: String(error) });
  }
}

/** A GET returns a health check, which makes the deployment easy to verify. */
function doGet() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var present = Object.keys(TABS).filter(function (tabName) {
    return spreadsheet.getSheetByName(tabName) !== null;
  });

  return json({
    ok: true,
    service: 'HR Agent dashboard endpoint',
    tabsReady: present,
    tabsMissing: Object.keys(TABS).filter(function (t) {
      return present.indexOf(t) === -1;
    }),
  });
}

function json(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
