import { settings } from '@devvit/web/server';
import { ChatGoogle } from '@langchain/google/node';

async function readApiKey(): Promise<string | null> {
  const raw = await settings.get<string>('googleApiKey').catch(() => undefined);
  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) return null;
  return raw.trim();
}

export async function getEditAdjudicator(): Promise<ChatGoogle | null> {
  const apiKey = await readApiKey();
  if (!apiKey) return null;
  return new ChatGoogle({
    apiKey,
    model: 'gemini-3.5-flash',
    maxRetries: 1,
  });
}

export async function getClusterNarrator(): Promise<ChatGoogle | null> {
  const apiKey = await readApiKey();
  if (!apiKey) return null;
  return new ChatGoogle({
    apiKey,
    model: 'gemini-3.5-flash',
    maxRetries: 1,
  });
}
