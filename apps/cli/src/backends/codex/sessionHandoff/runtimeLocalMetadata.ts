import type { ProviderRuntimeLocalHandoffMetadataBuilder } from '@/backends/types';

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const buildCodexRuntimeLocalHandoffMetadata: ProviderRuntimeLocalHandoffMetadataBuilder = ({
  vendorResumeId,
}) => {
  const trimmedVendorResumeId = normalizeOptionalString(vendorResumeId);
  return trimmedVendorResumeId ? { codexSessionId: trimmedVendorResumeId } : {};
};
