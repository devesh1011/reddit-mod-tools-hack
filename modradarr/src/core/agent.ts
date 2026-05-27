import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createHash } from 'node:crypto';
import {
  bumpAgentBudget,
  getAgentBudget,
  getCachedAdjudication,
  getCachedNarration,
  readSettings,
  setCachedAdjudication,
  setCachedNarration,
  type StoredCluster,
} from './redis-schema';
import { getEditAdjudicator, getClusterNarrator } from './agent-models';
import {
  buildAdjudicateUserMessage,
  buildNarrateUserMessage,
  CLUSTER_NARRATION_PROMPT,
  EDIT_ADJUDICATION_PROMPT,
  type NarrateClusterContext,
} from './agent-prompts';

export const adjudicateEditOutput = z.object({
  verdict: z.enum(['spam', 'legit', 'unclear']),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).max(4),
  suggestedAction: z.enum(['remove', 'flag', 'ignore']),
});
export type AdjudicateEditOutput = z.infer<typeof adjudicateEditOutput>;

export const narrateClusterOutput = z.object({
  narrative: z.string().max(500),
  campaignType: z.enum([
    'affiliate_spam',
    'crypto_scam',
    'malware_link',
    'engagement_farming',
    'astroturfing',
    'unknown_coordinated',
    'likely_benign',
  ]),
  recommendedAction: z.enum(['remove_all', 'review_individually', 'dismiss']),
  riskAdjustment: z.number().min(-0.3).max(0.3),
});
export type NarrateClusterOutput = z.infer<typeof narrateClusterOutput>;

export type AdjudicateEditInput = {
  bodyBefore: string;
  bodyAfter: string;
  addedUrls: string[];
  authorAgeDays: number | null;
  heuristicScore: number;
  heuristicSignals: string[];
};

const BORDERLINE_LOW = 0.3;
const BORDERLINE_HIGH = 0.7;
const DAILY_BUDGET_CALLS = 200;

function hashAdjudicationInput(input: AdjudicateEditInput): string {
  const payload = JSON.stringify({
    after: input.bodyAfter,
    urls: input.addedUrls.slice().sort(),
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

export async function adjudicateEdit(
  input: AdjudicateEditInput
): Promise<AdjudicateEditOutput | null> {
  const settings = await readSettings();
  if (settings.agentMode === 'off') return null;
  if (
    settings.agentMode === 'borderline' &&
    (input.heuristicScore < BORDERLINE_LOW || input.heuristicScore > BORDERLINE_HIGH)
  ) {
    return null;
  }

  const hash = hashAdjudicationInput(input);
  const cached = await getCachedAdjudication<AdjudicateEditOutput>(hash);
  if (cached) return cached;

  const model = await getEditAdjudicator();
  if (!model) return null;

  if ((await getAgentBudget()) >= DAILY_BUDGET_CALLS) {
    return null;
  }

  try {
    const structured = model.withStructuredOutput(adjudicateEditOutput, { name: 'adjudicate_edit' });
    const result = await structured.invoke([
      new SystemMessage(EDIT_ADJUDICATION_PROMPT),
      new HumanMessage(buildAdjudicateUserMessage(input)),
    ]);
    await setCachedAdjudication(hash, result);
    await bumpAgentBudget();
    return result;
  } catch (err) {
    console.error('[modradar] adjudicateEdit failed', err);
    return null;
  }
}

export async function narrateCluster(
  cluster: StoredCluster,
  itemPreviews: NarrateClusterContext['itemPreviews']
): Promise<NarrateClusterOutput | null> {
  const settings = await readSettings();
  if (settings.agentMode === 'off') return null;

  const cached = await getCachedNarration<NarrateClusterOutput>(cluster.id);
  if (cached) return cached;

  const model = await getClusterNarrator();
  if (!model) return null;

  if ((await getAgentBudget()) >= DAILY_BUDGET_CALLS) {
    return null;
  }

  try {
    const structured = model.withStructuredOutput(narrateClusterOutput, { name: 'narrate_cluster' });
    const result = await structured.invoke([
      new SystemMessage(CLUSTER_NARRATION_PROMPT),
      new HumanMessage(buildNarrateUserMessage({ cluster, itemPreviews })),
    ]);
    await setCachedNarration(cluster.id, result);
    await bumpAgentBudget();
    return result;
  } catch (err) {
    console.error('[modradar] narrateCluster failed', err);
    return null;
  }
}
