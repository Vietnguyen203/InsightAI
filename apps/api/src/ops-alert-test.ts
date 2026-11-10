// Sends a test alert to OPS_ALERT_WEBHOOK_URL so the alert channel can be verified after setup
// (D-58). Production: `docker compose -f docker/compose.prod.yml run --rm worker node dist/ops-alert-test.js`.
import { hostname } from 'node:os';
import { loadAppConfig } from './platform/config/config.module';
import { alertText, type AlertNotification } from './platform/ops/alert-rules';
import { postWebhook } from './platform/ops/notifier';

async function main(): Promise<number> {
  const config = loadAppConfig();
  if (!config.OPS_ALERT_WEBHOOK_URL) {
    console.error('OPS_ALERT_WEBHOOK_URL is not set');
    return 2;
  }
  const alert: AlertNotification = {
    status: 'FIRING',
    key: 'test_alert',
    summary: 'Test alert – the alert channel works',
    since: new Date().toISOString(),
  };
  const sent = await postWebhook(config.OPS_ALERT_WEBHOOK_URL, {
    text: alertText(alert, hostname()),
    alert,
  });
  console.log(sent ? 'Test alert sent' : 'Test alert FAILED (webhook did not answer 2xx)');
  return sent ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
