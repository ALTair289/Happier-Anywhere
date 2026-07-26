import type { SessionWorkStateStatusV1 } from '@/session/workState/sessionWorkStateMetadata';

export type AcpPlanSource = 'standard' | 'proprietary';

export type NormalizedAcpPlanItem = Readonly<{
  vendorRef?: string;
  title: string;
  status: SessionWorkStateStatusV1;
  order: number;
  priority?: string;
  phaseId?: string;
  phaseName?: string;
}>;

export type NormalizedAcpPlanSnapshot = Readonly<{
  providerId: string;
  turnId: string;
  correlationId?: string;
  source: AcpPlanSource;
  merge: boolean;
  markdown?: string;
  fileUri?: string;
  items: readonly NormalizedAcpPlanItem[];
}>;

export type AcpPlanInput = Readonly<{
  providerId: string;
  turnId: string;
  correlationId?: string;
  source: AcpPlanSource;
  merge: boolean;
  markdown?: string;
  fileUri?: string;
  items: readonly unknown[];
}>;

export type AcpPlanRemoval = Readonly<{
  providerId: string;
  turnId: string;
  correlationId: string;
  source: AcpPlanSource;
}>;

export type AcpPlanProjectionResult = Readonly<{
  kind: 'published' | 'duplicate' | 'shadowed' | 'late';
  fingerprint?: string;
}>;
