import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

export function resolveAccountSettingsHttpBaseUrl(): string {
  return resolveServerHttpBaseUrl();
}
