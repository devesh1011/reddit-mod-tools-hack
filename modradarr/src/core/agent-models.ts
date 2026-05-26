import { settings } from '@devvit/web/server';
import { ChatAnthropic } from '@langchain/anthropic';

const AGENT_TIMEOUT_MS = 8_000;

async function readAnthropicKey(): Promise<string | null> {
  const raw = await settings.get<string>('anthropicApiKey').catch(() => undefined);
  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) return null;
  return raw.trim();
}

export async function getEditAdjudicator(): Promise<ChatAnthropic | null> {
  const apiKey = await readAnthropicKey();
  if (!apiKey) return null;
  return new ChatAnthropic({
    apiKey,
    model: 'claude-haiku-4-5-20251001',
    temperature: 0,
    maxTokens: 400,
    maxRetries: 1,
    clientOptions: { timeout: AGENT_TIMEOUT_MS },
  });
}

export async function getClusterNarrator(): Promise<ChatAnthropic | null> {
  const apiKey = await readAnthropicKey();
  if (!apiKey) return null;
  return new ChatAnthropic({
    apiKey,
    model: 'claude-sonnet-4-6',
    temperature: 0.2,
    maxTokens: 600,
    maxRetries: 1,
    clientOptions: { timeout: AGENT_TIMEOUT_MS },
  });
}
