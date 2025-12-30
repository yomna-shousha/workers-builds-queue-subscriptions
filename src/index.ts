/**
 * Cloudflare Workers Builds → Slack Notifications (Gold Standard)
 *
 * - Consumes build events from a Cloudflare Queue
 * - Enriches with Builds API:
 *   - preview_url (if present)
 *   - logs (to extract the real error)
 * - Sends uniform, polished Slack Block Kit notifications
 *
 * @see https://developers.cloudflare.com/workers/ci-cd/builds
 * @see https://developers.cloudflare.com/queues/
 * @see https://developers.cloudflare.com/queues/event-subscriptions/
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface Env {
  SLACK_WEBHOOK_URL: string;
  CLOUDFLARE_API_TOKEN: string;
}

interface CloudflareEvent {
  type: string;
  source: {
    type: string;
    workerName?: string;
  };
  payload: {
    buildUuid: string;
    status: string;
    buildOutcome: string | null; // normalize at runtime (values vary)
    createdAt: string;
    initializingAt?: string;
    runningAt?: string;
    stoppedAt?: string;
    buildTriggerMetadata?: {
      buildTriggerSource?: string;
      branch?: string;
      commitHash?: string;
      commitMessage?: string;
      author?: string;
      buildCommand?: string;
      deployCommand?: string;
      rootDirectory?: string;
      repoName?: string;
      providerAccountName?: string;
      providerType?: string;
    };
  };
  metadata: {
    accountId: string;
    eventSubscriptionId: string;
    eventSchemaVersion: number;
    eventTimestamp: string;
  };
}

type BuildState = 'succeeded' | 'failed' | 'canceled' | 'unknown';

// =============================================================================
// SMALL UTILS
// =============================================================================

function safeStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function truncate(s: string, max = 80): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function firstLine(s: string): string {
  return safeStr(s).split('\n')[0].trim();
}

function shortSha(sha?: string): string {
  const s = safeStr(sha);
  return s ? s.slice(0, 7) : '';
}

function shortBuildId(buildUuid?: string): string {
  const s = safeStr(buildUuid);
  // Use first 7-8 characters for a stable short id even if format changes
  return s ? s.replace(/^build-/, '').slice(0, 8) : '';
}

function parseDate(iso?: string): number | null {
  const s = safeStr(iso);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function formatDurationMs(ms: number | null): string {
  if (!ms || ms <= 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function isProductionBranch(branch?: string): boolean {
  const b = safeStr(branch).toLowerCase();
  if (!b) return true; // default to prod-ish if unknown
  return ['main', 'master', 'production', 'prod'].includes(b);
}

function normalizeBuildState(event: CloudflareEvent): BuildState {
  const type = safeStr(event.type).toLowerCase();
  const outcome = safeStr(event.payload?.buildOutcome).toLowerCase();
  const status = safeStr(event.payload?.status).toLowerCase();

  // Prefer explicit event.type if present
  if (type.includes('succeeded')) return 'succeeded';
  if (type.includes('failed')) return 'failed';
  if (type.includes('canceled') || type.includes('cancelled')) return 'canceled';

  // Fall back to outcome/status variations
  const canceledVals = new Set(['canceled', 'cancelled', 'canceled_build', 'cancelled_build']);
  const failedVals = new Set(['failed', 'failure', 'error']);
  const successVals = new Set(['success', 'succeeded', 'ok']);

  if (canceledVals.has(outcome) || canceledVals.has(status)) return 'canceled';
  if (failedVals.has(outcome) || failedVals.has(status)) return 'failed';
  if (successVals.has(outcome) || successVals.has(status)) return 'succeeded';

  return 'unknown';
}

// =============================================================================
// URL BUILDERS
// =============================================================================

function getCommitUrl(event: CloudflareEvent): string | null {
  const meta = event.payload?.buildTriggerMetadata;
  const repoName = safeStr(meta?.repoName);
  const commitHash = safeStr(meta?.commitHash);
  const acct = safeStr(meta?.providerAccountName);
  const provider = safeStr(meta?.providerType).toLowerCase();

  if (!repoName || !commitHash || !acct) return null;

  if (provider === 'github') {
    return `https://github.com/${acct}/${repoName}/commit/${commitHash}`;
  }
  if (provider === 'gitlab') {
    return `https://gitlab.com/${acct}/${repoName}/-/commit/${commitHash}`;
  }
  return null;
}

function getDashboardBuildUrl(event: CloudflareEvent): string | null {
  const accountId = safeStr(event.metadata?.accountId);
  const buildUuid = safeStr(event.payload?.buildUuid);

  // Note: "workerName" in dashboard URL must match the service name.
  // We best-effort it from event.source.workerName then repoName.
  const meta = event.payload?.buildTriggerMetadata;
  const workerName =
    safeStr(event.source?.workerName) ||
    safeStr(meta?.repoName) ||
    'worker';

  if (!accountId || !buildUuid) return null;

  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${workerName}/production/builds/${buildUuid}`;
}

// =============================================================================
// ERROR EXTRACTION (logs -> best snippet)
// =============================================================================

function extractBuildError(logs: string[]): string {
  if (!Array.isArray(logs) || logs.length === 0) return 'No logs available';

  // Prefer strong, user-facing error lines
  const strongPatterns = [
    /no config file found/i,
    /entry-point file .* was not found/i,
    /module not found/i,
    /cannot find module/i,
    /command failed/i,
    /failed:\s/i,
    /^\s*\[error\]/i,
    /^\s*error:/i,
    /^\s*✘/,
  ];

  // Search from the end to find the final failure cause
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i]?.trim();
    if (!line) continue;
    if (line.startsWith('at ')) continue; // skip stack trace frames
    if (strongPatterns.some((re) => re.test(line))) {
      // include next line if it adds context and isn't stack
      const next = logs[i + 1]?.trim();
      let msg = line;
      if (next && !next.startsWith('at ') && next.length < 200) {
        msg += `\n${next}`;
      }
      return msg.length > 700 ? msg.slice(0, 700) + '…' : msg;
    }
  }

  // Fallback: last non-empty non-stack line
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i]?.trim();
    if (!line) continue;
    if (line.startsWith('at ')) continue;
    return line.length > 700 ? line.slice(0, 700) + '…' : line;
  }

  return 'Build failed';
}

function classifyErrorHint(error: string): string | null {
  const e = error.toLowerCase();

  if (e.includes('no config file') || e.includes('wrangler.(') || e.includes('wrangler.toml')) {
    return 'Likely config missing (add wrangler config).';
  }
  if (e.includes('entry-point') || e.includes('worker.js was not found') || e.includes('.open-next')) {
    return 'Likely missing build output (check adapter/build step).';
  }
  if (e.includes('module not found') || e.includes('cannot find module')) {
    return 'Likely dependency issue (install/build path).';
  }
  if (e.includes('command failed') || e.startsWith('failed:')) {
    return 'Build command failed (check build logs for the failing step).';
  }
  return null;
}

// =============================================================================
// SLACK BLOCKS (Gold Standard, Uniform Skeleton)
// =============================================================================

function buildSlackBlocks(
  event: CloudflareEvent,
  previewUrl: string | null,
  liveUrl: string | null,
  logs: string[]
) {
  const meta = event.payload?.buildTriggerMetadata;
  const workerName = safeStr(event.source?.workerName) || safeStr(meta?.repoName) || 'Worker';
  const branch = safeStr(meta?.branch);
  const commitHash = safeStr(meta?.commitHash);
  const commitMsg = truncate(firstLine(meta?.commitMessage || ''), 90);
  const authorRaw = safeStr(meta?.author);
  const author = authorRaw.includes('@') ? authorRaw.split('@')[0] : authorRaw;

  const commitUrl = getCommitUrl(event);
  const dashUrl = getDashboardBuildUrl(event);

  const state = normalizeBuildState(event);
  const isProd = isProductionBranch(branch);
  const envLabel = isProd ? 'Production' : 'Preview';

  const createdAt = parseDate(event.payload?.createdAt);
  const runningAt = parseDate(event.payload?.runningAt) ?? parseDate(event.payload?.initializingAt) ?? createdAt;
  const stoppedAt = parseDate(event.payload?.stoppedAt);
  const durationMs = stoppedAt && runningAt ? stoppedAt - runningAt : (stoppedAt && createdAt ? stoppedAt - createdAt : null);
  const duration = formatDurationMs(durationMs);

  const buildId = shortBuildId(event.payload?.buildUuid);
  const sha7 = shortSha(commitHash);

  // Header text + emoji
  const header =
    state === 'succeeded'
      ? `✅ ${workerName} — ${envLabel} deploy succeeded`
      : state === 'failed'
        ? `❌ ${workerName} — ${envLabel} build failed`
        : state === 'canceled'
          ? `⚠️ ${workerName} — ${envLabel} build canceled`
          : `📢 ${workerName} — build update`;

  // Fields (uniform across states)
  const fields: any[] = [];
  if (branch) fields.push({ type: 'mrkdwn', text: `*Branch*\n\`${branch}\`` });
  if (sha7) {
    fields.push({
      type: 'mrkdwn',
      text: `*Commit*\n${commitUrl ? `<${commitUrl}|${sha7}>` : `\`${sha7}\``}`,
    });
  }
  if (author) fields.push({ type: 'mrkdwn', text: `*Author*\n${author}` });
  fields.push({ type: 'mrkdwn', text: `*Duration*\n${duration}` });

  // Context footer (uniform)
  const contextBits: string[] = [];
  if (commitMsg) contextBits.push(`“${commitMsg}”`);
  const trigger = safeStr(meta?.buildTriggerSource);
  if (trigger) contextBits.push(`trigger: \`${trigger}\``);
  if (buildId) contextBits.push(`build: \`${buildId}\``);

  // Actions (uniform-ish; success prefers Preview/Worker as primary)
  const actions: any[] = [];

  // Primary URL button
  if (state === 'succeeded') {
    if (!isProd && previewUrl) {
      actions.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View Preview', emoji: true },
        url: previewUrl,
        style: 'primary',
      });
    } else if (isProd && liveUrl) {
      actions.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View Worker', emoji: true },
        url: liveUrl,
        style: 'primary',
      });
    }
  }

  // Logs/Build buttons
  if (dashUrl) {
    if (state === 'failed') {
      actions.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View Full Logs', emoji: true },
        url: dashUrl,
        style: 'danger',
      });
    } else {
      actions.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View Build', emoji: true },
        url: dashUrl,
      });
    }
  }

  // Commit button
  if (commitUrl) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: 'View Commit', emoji: true },
      url: commitUrl,
    });
  }

  // Build blocks
  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
  ];

  if (fields.length > 0) {
    blocks.push({ type: 'section', fields });
  }

  if (contextBits.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: contextBits.join('  •  ') }],
    });
  }

  // Failed: error snippet + hint
  if (state === 'failed') {
    const error = extractBuildError(logs);
    const hint = classifyErrorHint(error);

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`${error}\`\`\`` },
    });

    if (hint) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `💡 ${hint}` }],
      });
    }
  }

  if (actions.length > 0) {
    // Slack allows up to 5 buttons in actions
    blocks.push({ type: 'actions', elements: actions.slice(0, 5) });
  }

  return { blocks };
}

// =============================================================================
// CLOUDFLARE API HELPERS
// =============================================================================

async function cfGet<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare API returned non-JSON: ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok || json?.success === false) {
    throw new Error(`Cloudflare API error: ${res.status} ${JSON.stringify(json)?.slice(0, 300)}`);
  }
  return json as T;
}

async function fetchPreviewOrLiveUrl(
  accountId: string,
  buildUuid: string,
  workerName: string,
  token: string
): Promise<{ previewUrl: string | null; liveUrl: string | null }> {
  let previewUrl: string | null = null;
  let liveUrl: string | null = null;

  // Build details may include preview_url
  type BuildDetailsResponse = { result?: { preview_url?: string | null } };
  const buildDetails = await cfGet<BuildDetailsResponse>(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/builds/${buildUuid}`,
    token
  );

  previewUrl = safeStr(buildDetails?.result?.preview_url) || null;

  // If no preview_url, fall back to workers.dev live URL (production-ish)
  if (!previewUrl) {
    type SubdomainResponse = { result?: { subdomain?: string } };
    const sub = await cfGet<SubdomainResponse>(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      token
    );
    const subdomain = safeStr(sub?.result?.subdomain);
    if (subdomain && workerName) {
      liveUrl = `https://${workerName}.${subdomain}.workers.dev`;
    }
  }

  return { previewUrl, liveUrl };
}

async function fetchAllBuildLogs(
  accountId: string,
  buildUuid: string,
  token: string
): Promise<string[]> {
  const lines: string[] = [];
  let cursor: string | null = null;

  // We page until truncated=false
  while (true) {
    const endpoint =
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/builds/${buildUuid}/logs` +
      (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');

    type LogsResponse = { result?: { lines?: [number, string][]; truncated?: boolean; cursor?: string } };
    const data = await cfGet<LogsResponse>(endpoint, token);

    const page = data?.result?.lines?.map((l) => l?.[1]).filter(Boolean) as string[] | undefined;
    if (page?.length) lines.push(...page);

    const truncated = Boolean(data?.result?.truncated);
    cursor = truncated ? safeStr(data?.result?.cursor) : null;

    if (!truncated || !cursor) break;
  }

  return lines;
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

export default {
  async queue(batch: MessageBatch<CloudflareEvent>, env: Env): Promise<void> {
    if (!env.SLACK_WEBHOOK_URL) {
      console.error('SLACK_WEBHOOK_URL is not configured');
      for (const m of batch.messages) m.ack();
      return;
    }

    for (const message of batch.messages) {
      try {
        const event = message.body;

        if (!event?.type || !event?.payload || !event?.metadata) {
          console.error('Invalid event structure:', JSON.stringify(event));
          message.ack();
          continue;
        }

        // Ignore noisy lifecycle events (customize as you like)
        const t = safeStr(event.type).toLowerCase();
        if (t.includes('started') || t.includes('queued')) {
          message.ack();
          continue;
        }

        const state = normalizeBuildState(event);
        const accountId = safeStr(event.metadata.accountId);
        const buildUuid = safeStr(event.payload.buildUuid);
        const meta = event.payload.buildTriggerMetadata;

        const workerName =
          safeStr(event.source?.workerName) ||
          safeStr(meta?.repoName) ||
          'worker';

        let previewUrl: string | null = null;
        let liveUrl: string | null = null;
        let logs: string[] = [];

        // Enrich success with URLs
        if (state === 'succeeded' && accountId && buildUuid && env.CLOUDFLARE_API_TOKEN) {
          try {
            const urls = await fetchPreviewOrLiveUrl(accountId, buildUuid, workerName, env.CLOUDFLARE_API_TOKEN);
            previewUrl = urls.previewUrl;
            liveUrl = urls.liveUrl;
          } catch (e) {
            console.error('Failed to fetch preview/live URL:', e);
          }
        }

        // Enrich failure with logs
        if (state === 'failed' && accountId && buildUuid && env.CLOUDFLARE_API_TOKEN) {
          try {
            logs = await fetchAllBuildLogs(accountId, buildUuid, env.CLOUDFLARE_API_TOKEN);
          } catch (e) {
            console.error('Failed to fetch build logs:', e);
          }
        }

        const slackPayload = buildSlackBlocks(event, previewUrl, liveUrl, logs);

        const res = await fetch(env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slackPayload),
        });

        if (!res.ok) {
          console.error('Slack webhook error:', res.status, await res.text());
        }

        message.ack();
      } catch (err) {
        console.error('Error processing message:', err);
        message.ack();
      }
    }
  },
};
