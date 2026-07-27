import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { enqueueRuntimeAuthFailureReportOutboxItem } from '../runtimeAuthFailureReportOutbox';

const [outboxDir, barrierDir, childId] = process.argv.slice(2);
if (!outboxDir || !barrierDir || !childId) process.exit(2);

await writeFile(join(barrierDir, `ready-${childId}`), '', 'utf8');
while (true) {
  try {
    await access(join(barrierDir, 'go'));
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const result = await enqueueRuntimeAuthFailureReportOutboxItem({
  outboxDir,
  report: {
    sessionId: 'sess_child_process_concurrent',
    switchesThisTurn: 1,
    classification: {
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
      resetsAtMs: 1_700_000_100_000,
      retryAfterMs: 60_000,
      quotaScope: 'account',
      providerLimitId: 'codex-daily-limit',
      source: 'structured_provider_error',
    },
  },
  nowMs: () => 1_700_000_000_000,
});

if (result.status !== 'enqueued') process.exit(3);
process.stdout.write(result.item.reportId);
