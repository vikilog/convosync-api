/** 0=Sun … 6=Sat (JS Date.getDay) */
export type BusinessHoursConfig = {
  enabled?: boolean;
  /** "HH:mm" 24h local to timezone */
  startTime?: string;
  endTime?: string;
  /** Empty / missing = every day */
  daysOfWeek?: number[];
};

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function parseHm(value: string | undefined, fallback: string): { h: number; m: number } {
  const raw = (value?.trim() || fallback).match(/^(\d{1,2}):(\d{2})$/);
  if (!raw) return { h: 8, m: 0 };
  return {
    h: Math.min(23, Math.max(0, Number(raw[1]))),
    m: Math.min(59, Math.max(0, Number(raw[2]))),
  };
}

function zonedParts(date: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const weekday = WEEKDAY[map.weekday ?? 'Sun'] ?? 0;
  const hour = Number(map.hour ?? 0);
  const minute = Number(map.minute ?? 0);
  return {
    weekday,
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    minutes: hour * 60 + minute,
  };
}

/** Approximate UTC instant for a wall-clock time in `timeZone` (iterative). */
function zonedWallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  // ponytail: ± guess then correct via formatToParts — fine for hour-level resume (ceiling: DST edges ±1h once)
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(utc), timeZone);
    const want = hour * 60 + minute;
    const diffMin = want - p.minutes + (day - p.day) * 24 * 60;
    utc += diffMin * 60_000;
  }
  return new Date(utc);
}

function dayAllowed(weekday: number, days: number[] | undefined): boolean {
  if (!days || days.length === 0) return true;
  return days.includes(weekday);
}

export function isWithinBusinessHours(
  date: Date,
  config: BusinessHoursConfig,
  timeZone: string
): boolean {
  if (!config.enabled) return true;
  const p = zonedParts(date, timeZone);
  if (!dayAllowed(p.weekday, config.daysOfWeek)) return false;
  const start = parseHm(config.startTime, '08:00');
  const end = parseHm(config.endTime, '22:00');
  const startM = start.h * 60 + start.m;
  const endM = end.h * 60 + end.m;
  if (startM === endM) return true;
  if (startM < endM) return p.minutes >= startM && p.minutes < endM;
  return p.minutes >= startM || p.minutes < endM;
}

/** Next instant at/after `from` that falls inside the configured window. */
export function nextAllowedInstant(
  from: Date,
  config: BusinessHoursConfig,
  timeZone: string
): Date {
  if (!config.enabled) return from;
  if (isWithinBusinessHours(from, config, timeZone)) return from;

  const start = parseHm(config.startTime, '08:00');
  // Scan up to 8 days ahead for the next allowed start
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const probe = new Date(from.getTime() + dayOffset * 86_400_000);
    const p = zonedParts(probe, timeZone);
    if (!dayAllowed(p.weekday, config.daysOfWeek)) continue;

    const candidate = zonedWallToUtc(p.year, p.month, p.day, start.h, start.m, timeZone);
    if (candidate.getTime() < from.getTime()) continue;
    if (isWithinBusinessHours(candidate, config, timeZone)) return candidate;
  }
  return from;
}

/**
 * Fixed delay first, then snap resume into business hours if configured.
 * Returns total wait ms from `now`.
 */
export function resolveWaitMs(
  baseDelayMs: number,
  businessHours: BusinessHoursConfig | undefined,
  timeZone: string,
  now = Date.now()
): number {
  const target = now + Math.max(0, baseDelayMs);
  if (!businessHours?.enabled) return Math.max(0, target - now);
  const resumeAt = nextAllowedInstant(new Date(target), businessHours, timeZone);
  return Math.max(0, resumeAt.getTime() - now);
}

export function normalizeBusinessHours(raw: unknown): BusinessHoursConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (!o.enabled) return { enabled: false };
  const days = Array.isArray(o.daysOfWeek)
    ? o.daysOfWeek.map((d) => Number(d)).filter((d) => d >= 0 && d <= 6)
    : [];
  return {
    enabled: true,
    startTime: String(o.startTime ?? '08:00'),
    endTime: String(o.endTime ?? '22:00'),
    daysOfWeek: days,
  };
}
