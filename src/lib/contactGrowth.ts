/** Contact growth chart windows + buckets in an IANA timezone (not UTC wall clock). */

export type GrowthRangeKey = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(tz?: string): string {
  if (tz && isValidTimeZone(tz)) return tz;
  return 'Asia/Kolkata';
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** Convert a wall-clock time in `timeZone` to a UTC Date. */
export function wallTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0
): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  for (let i = 0; i < 4; i++) {
    const p = zonedParts(guess, timeZone);
    const asUtcMs = Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      p.hour,
      p.minute,
      p.second,
      guess.getUTCMilliseconds()
    );
    const wantedMs = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    guess = new Date(guess.getTime() + (wantedMs - asUtcMs));
  }
  return guess;
}

export function zonedYmd(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function zonedHourKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}`;
}

export function addZonedDays(timeZone: string, ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const utc = wallTimeToUtc(timeZone, y, m, d, 12, 0, 0, 0);
  utc.setUTCDate(utc.getUTCDate() + deltaDays);
  return zonedYmd(utc, timeZone);
}

function zonedWeekdaySun0(date: Date, timeZone: string): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[wd] ?? 1;
}

export function resolveGrowthWindow(
  range: string | undefined,
  timeZone: string,
  dateFrom?: string,
  dateTo?: string
): { start: Date; end: Date; mode: 'hour' | 'day' } {
  const now = new Date();
  const todayParts = zonedParts(now, timeZone);
  const todayYmd = `${todayParts.year}-${pad2(todayParts.month)}-${pad2(todayParts.day)}`;

  if (range === 'today') {
    const start = wallTimeToUtc(timeZone, todayParts.year, todayParts.month, todayParts.day, 0, 0, 0, 0);
    return { start, end: now, mode: 'hour' };
  }
  if (range === 'yesterday') {
    const ymd = addZonedDays(timeZone, todayYmd, -1);
    const [y, m, d] = ymd.split('-').map(Number);
    const start = wallTimeToUtc(timeZone, y, m, d, 0, 0, 0, 0);
    const end = wallTimeToUtc(timeZone, y, m, d, 23, 59, 59, 999);
    return { start, end, mode: 'hour' };
  }
  if (range === 'week') {
    const dayNum = zonedWeekdaySun0(now, timeZone);
    const mondayOffset = dayNum === 0 ? 6 : dayNum - 1;
    const mondayYmd = addZonedDays(timeZone, todayYmd, -mondayOffset);
    const [y, m, d] = mondayYmd.split('-').map(Number);
    const start = wallTimeToUtc(timeZone, y, m, d, 0, 0, 0, 0);
    const end = wallTimeToUtc(
      timeZone,
      todayParts.year,
      todayParts.month,
      todayParts.day,
      23,
      59,
      59,
      999
    );
    return { start, end, mode: 'day' };
  }
  if (range === 'custom') {
    if (
      dateFrom &&
      dateTo &&
      /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) &&
      /^\d{4}-\d{2}-\d{2}$/.test(dateTo)
    ) {
      const [fy, fm, fd] = dateFrom.split('-').map(Number);
      const [ty, tm, td] = dateTo.split('-').map(Number);
      const start = wallTimeToUtc(timeZone, fy, fm, fd, 0, 0, 0, 0);
      const end = wallTimeToUtc(timeZone, ty, tm, td, 23, 59, 59, 999);
      if (start <= end) return { start, end, mode: 'day' };
    }
  }
  const start = wallTimeToUtc(timeZone, todayParts.year, todayParts.month, 1, 0, 0, 0, 0);
  const end = wallTimeToUtc(
    timeZone,
    todayParts.year,
    todayParts.month,
    todayParts.day,
    23,
    59,
    59,
    999
  );
  return { start, end, mode: 'day' };
}

export function buildGrowthBuckets(
  rows: { createdAt: Date }[],
  start: Date,
  end: Date,
  mode: 'hour' | 'day',
  timeZone: string
): { date: string; count: number; label: string }[] {
  const map = new Map<string, number>();

  if (mode === 'hour') {
    const cursor = new Date(start);
    cursor.setUTCMinutes(0, 0, 0);
    while (cursor <= end) {
      map.set(zonedHourKey(cursor, timeZone), 0);
      cursor.setUTCHours(cursor.getUTCHours() + 1);
    }
    for (const row of rows) {
      const key = zonedHourKey(row.createdAt, timeZone);
      if (map.has(key)) map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].map(([key, count]) => {
      const hour = Number(key.slice(11, 13));
      return {
        date: key,
        count,
        label: `${pad2(hour)}:00`,
      };
    });
  }

  let dayCursor = zonedYmd(start, timeZone);
  const endYmd = zonedYmd(end, timeZone);
  while (dayCursor <= endYmd) {
    map.set(dayCursor, 0);
    dayCursor = addZonedDays(timeZone, dayCursor, 1);
  }
  for (const row of rows) {
    const key = zonedYmd(row.createdAt, timeZone);
    if (map.has(key)) map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([date, count]) => {
    const [y, m, d] = date.split('-').map(Number);
    const noon = wallTimeToUtc(timeZone, y, m, d, 12, 0, 0, 0);
    return {
      date,
      count,
      label: noon.toLocaleDateString('en-IN', {
        timeZone,
        day: 'numeric',
        month: 'short',
      }),
    };
  });
}
