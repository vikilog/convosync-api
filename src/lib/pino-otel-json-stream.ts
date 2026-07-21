/**
 * Pino → OTel Logs with the FULL JSON line as body (same as terminal),
 * so Grafana Loki Explore shows method/url/status/trace_id — not only "request completed".
 */
import { Writable } from 'node:stream';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

const LEVEL_TO_SEV: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};

const LEVEL_LABEL: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

export function createOtelJsonLogStream(): Writable {
  const otelLogger = logs.getLogger('convosync-backend');

  return new Writable({
    write(chunk, _encoding, callback) {
      const line = (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).trim();
      if (!line) {
        callback();
        return;
      }

      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        const level = typeof rec.level === 'number' ? rec.level : 30;
        const attrs: Record<string, string> = {};
        if (typeof rec.trace_id === 'string') attrs.trace_id = rec.trace_id;
        if (typeof rec.span_id === 'string') attrs.span_id = rec.span_id;
        if (typeof rec.reqId === 'string') attrs.reqId = rec.reqId;

        otelLogger.emit({
          body: line,
          severityNumber: LEVEL_TO_SEV[level] ?? SeverityNumber.INFO,
          severityText: LEVEL_LABEL[level] ?? 'info',
          attributes: attrs,
        });
      } catch {
        otelLogger.emit({
          body: line,
          severityNumber: SeverityNumber.INFO,
          severityText: 'info',
        });
      }

      callback();
    },
  });
}
