const TIMEOUT_MS = 5_000;

/**
 * Posts an alert to the webhook as Slack-compatible JSON (`text`, plus the structured alert).
 * Returns false instead of throwing: a broken channel must not stop the monitor, and the alert is
 * always in the log as well.
 */
export async function postWebhook(
  url: string,
  body: { text: string; [key: string]: unknown },
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Dead-man switch ping (healthchecks.io style): an outside service alerts when pings stop. */
export async function ping(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}
