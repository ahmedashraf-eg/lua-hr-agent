/**
 * SeedPoliciesTool.ts — load the knowledge base into Lua's Data collection.
 *
 * There is no bulk import, and `Data` is only reachable from inside the agent
 * runtime, so seeding runs as a tool you invoke once:
 *
 *   lua test        → select seed_policies → { }
 *
 * Idempotent by design. It reads what is already in the collection and skips
 * documents whose policyId is present, so running it twice does not produce
 * duplicate entries competing in search results. Pass replace: true after
 * editing policy text to refresh everything.
 */

import { Data, LuaTool } from 'lua-cli';
import { z } from 'zod';

import { POLICIES, searchTextFor } from '../knowledge/policies';

const COLLECTION = 'hr_policies';

export class SeedPoliciesTool implements LuaTool {
  name = 'seed_policies';
  description =
    'Load or refresh the HR policy knowledge base. Run once at setup, not during normal conversation.';

  inputSchema = z.object({
    replace: z
      .boolean()
      .optional()
      .default(false)
      .describe('Delete and rewrite every document, rather than skipping ones already present'),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const created: string[] = [];
    const skipped: string[] = [];
    const removed: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    // Read what is already stored so re-runs stay idempotent.
    let existing: Array<{ id: string; data: Record<string, any> }> = [];
    try {
      const page = await Data.get(COLLECTION, {}, 1, 100);
      existing = page.data ?? [];
    } catch {
      // A collection that does not exist yet reads as empty, not as an error.
      existing = [];
    }

    const byPolicyId = new Map<string, string>();
    for (const entry of existing) {
      const policyId = entry.data?.policyId;
      if (typeof policyId === 'string') byPolicyId.set(policyId, entry.id);
    }

    if (input.replace) {
      for (const [policyId, entryId] of byPolicyId) {
        try {
          await Data.delete(COLLECTION, entryId);
          removed.push(policyId);
        } catch (error) {
          failed.push({
            id: policyId,
            error: error instanceof Error ? error.message : 'delete failed',
          });
        }
      }
      byPolicyId.clear();
    }

    for (const policy of POLICIES) {
      if (byPolicyId.has(policy.id)) {
        skipped.push(policy.id);
        continue;
      }

      try {
        await Data.create(
          COLLECTION,
          {
            policyId: policy.id,
            title: policy.title,
            titleAr: policy.titleAr,
            category: policy.category,
            countries: policy.countries,
            content: policy.content,
            lastReviewed: policy.lastReviewed,
            // Deliberately NOT `updatedAt` — DataEntryInstance carries its own
            // updatedAt timestamp, and the proxy would shadow whichever we set.
            seededAt: new Date().toISOString(),
          },
          // Must be a plain string — the options-object form fails in a
          // deployed agent with "searchText must be a string".
          searchTextFor(policy),
        );
        created.push(policy.id);
      } catch (error) {
        failed.push({
          id: policy.id,
          error: error instanceof Error ? error.message : 'create failed',
        });
      }
    }

    return {
      ok: failed.length === 0,
      collection: COLLECTION,
      created: created.length,
      skipped: skipped.length,
      removed: removed.length,
      failed,
      documents: { created, skipped, removed },
      note:
        created.length === 0 && skipped.length > 0
          ? 'Knowledge base already seeded. Pass replace: true to refresh after editing policy text.'
          : `Knowledge base ready with ${created.length + skipped.length} documents.`,
    };
  }
}
