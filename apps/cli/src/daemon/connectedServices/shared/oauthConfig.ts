import { resolveConnectedAccountOauthConfig } from '@/daemon/connectedServices/descriptors/connectedAccountDescriptors';

export function resolveOpenAiCodexOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveConnectedAccountOauthConfig('openai-codex', env).clientId;
}

export function resolveOpenAiCodexOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveConnectedAccountOauthConfig('openai-codex', env).tokenUrl;
}

export function resolveGeminiOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveConnectedAccountOauthConfig('gemini', env).clientId;
}

export function resolveGeminiOauthClientSecret(env: NodeJS.ProcessEnv): string {
  return resolveConnectedAccountOauthConfig('gemini', env).clientSecret ?? '';
}

export function resolveGeminiOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveConnectedAccountOauthConfig('gemini', env).tokenUrl;
}
