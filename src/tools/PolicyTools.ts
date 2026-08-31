/**
 * PolicyTools.ts — SOP and policy lookup over the knowledge base.
 *
 * The brief is explicit that when no SOP covers a request, the agent must log
 * the gap and escalate to HR rather than answer anyway. That branch is the
 * point of this tool, not an afterthought: an HR agent that invents policy is
 * worse than one that admits it does not know.
 */

import { Data, LuaTool, type DataEntry } from 'lua-cli';
import { z } from 'zod';

import { logPolicyGap } from '../integrations/sheets';
import { currentChannel } from './shared';

const COLLECTION = 'hr_policies';
const MATCH_THRESHOLD = 0.7;

export class SearchPoliciesTool implements LuaTool {
  name = 'search_policies';
  description =
    'Search HR policies and standard operating procedures. Use for any question about company process.';

  inputSchema = z.object({
    query: z.string().describe('The policy question, in the employee’s own words'),
    employeeId: z
      .string()
      .optional()
      .describe('The asking employee’s ID, recorded against any gap that is logged'),
    country: z
      .string()
      .optional()
      .describe('Country code, where the answer may be country-specific'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const query = input.country ? `${input.query} (${input.country})` : input.query;

    let results: DataEntry[] = [];

    try {
      results = await Data.search(COLLECTION, query, 5, MATCH_THRESHOLD);
    } catch (error) {
      return {
        ok: false,
        error: 'knowledge_base_unavailable',
        detail: error instanceof Error ? error.message : 'The policy knowledge base could not be reached.',
        action: 'Tell the employee you cannot check policy right now and offer to escalate to HR.',
      };
    }

    /* ------------------------------------------------- the gap branch */
    if (!results.length) {
      const gap = await logPolicyGap({
        query: input.query,
        employeeId: input.employeeId,
        channel: currentChannel(),
      });

      return {
        ok: true,
        found: false,
        query: input.query,
        gapLogged: gap.logged,
        escalated: true,
        explanation:
          'No standard operating procedure covers this request. It has been logged as a policy gap and routed to HR.',
        agentGuidance:
          'Say plainly that no documented policy covers this, that you have logged it for HR, and that someone will follow up. Do NOT infer an answer from related policies or general knowledge.',
      };
    }

    return {
      ok: true,
      found: true,
      query: input.query,
      count: results.length,
      // `entry.field` resolves through the DataEntryInstance proxy. Note the
      // review date is read as `lastReviewed`, not `updatedAt` — the entry
      // carries its own `updatedAt` timestamp and the proxy would shadow ours.
      policies: results.map((entry) => ({
        policyId: entry.policyId,
        title: entry.title,
        titleAr: entry.titleAr,
        content: entry.content,
        category: entry.category,
        lastReviewed: entry.lastReviewed,
        relevance: entry.score !== undefined ? `${Math.round(entry.score * 100)}%` : undefined,
      })),
      agentGuidance:
        'Answer from these documents only. Quote the policy title you relied on so the employee can look it up. If they asked something these documents do not cover, treat that as a gap rather than filling it in.',
    };
  }
}
