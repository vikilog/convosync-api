/**
 * Host CPU / RAM that match Activity Monitor / htop —
 * not loadavg and not raw os.freemem() (wrong on macOS).
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type HostCpuSample = { idle: number; total: number };
export type HostRamSample = { usedBytes: number; totalBytes: number; source: string };

let prevCpu: HostCpuSample | null = null;

export function hostCoreCount(): number {
  const n = os.cpus().length;
  if (n > 0) return n;
  if (typeof os.availableParallelism === 'function') {
    const p = os.availableParallelism();
    if (p > 0) return p;
  }
  return 1;
}

function sumOsCpuTimes(): HostCpuSample | null {
  const cpus = os.cpus();
  if (!cpus.length) return null;
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

async function readLinuxCpuTimes(): Promise<HostCpuSample | null> {
  try {
    const text = await readFile('/proc/stat', 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return null;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
    const total = parts.reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0);
    return total > 0 ? { idle, total } : null;
  } catch {
    return null;
  }
}

/** macOS: parse `top` CPU usage line (kern.cp_time is often unavailable). */
async function readDarwinCpuPct(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/top', ['-l', '2', '-s', '1', '-n', '0'], {
      timeout: 8000,
      maxBuffer: 1024 * 1024,
    });
    const lines = stdout.split('\n').filter((l) => /CPU usage:/i.test(l));
    const last = lines[lines.length - 1];
    if (!last) return null;
    const user = last.match(/([\d.]+)%\s*user/i);
    const sys = last.match(/([\d.]+)%\s*sys/i);
    if (!user || !sys) return null;
    return Math.min(100, Math.max(0, Math.round(parseFloat(user[1]) + parseFloat(sys[1]))));
  } catch {
    return null;
  }
}

function busyPctFromDelta(prev: HostCpuSample, cur: HostCpuSample): number {
  const idleDiff = cur.idle - prev.idle;
  const totalDiff = cur.total - prev.total;
  if (totalDiff <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((1 - idleDiff / totalDiff) * 100)));
}

/** True busy % since previous sample (or a short calibrated first sample). */
export async function sampleHostCpuPct(): Promise<{
  cpuPct: number;
  cores: number;
  load1: number;
}> {
  const cores = hostCoreCount();
  const load1 = Math.round((os.loadavg()[0] ?? 0) * 100) / 100;

  const cur = sumOsCpuTimes() ?? (await readLinuxCpuTimes());
  if (cur) {
    if (!prevCpu || cur.total <= prevCpu.total) {
      prevCpu = cur;
      await new Promise((r) => setTimeout(r, 150));
      const cur2 = sumOsCpuTimes() ?? (await readLinuxCpuTimes());
      if (!cur2) return { cpuPct: 0, cores, load1 };
      const cpuPct = busyPctFromDelta(cur, cur2);
      prevCpu = cur2;
      return { cpuPct, cores, load1 };
    }
    const cpuPct = busyPctFromDelta(prevCpu, cur);
    prevCpu = cur;
    return { cpuPct, cores, load1 };
  }

  const darwin = await readDarwinCpuPct();
  if (darwin != null) return { cpuPct: darwin, cores, load1 };

  // last-resort (not real % — load average)
  const cpuPct = Math.min(100, Math.round((load1 / cores) * 100));
  return { cpuPct, cores, load1 };
}

async function readLinuxRam(): Promise<HostRamSample | null> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const get = (key: string) => {
      const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = get('MemTotal');
    const available = get('MemAvailable');
    if (total == null || available == null) return null;
    return {
      totalBytes: total,
      usedBytes: Math.max(0, total - available),
      source: 'meminfo',
    };
  } catch {
    return null;
  }
}

function parseVmStatPages(out: string): Record<string, number> {
  const pages: Record<string, number> = {};
  let pageSize = 4096;
  const sizeMatch = out.match(/page size of (\d+) bytes/i);
  if (sizeMatch) pageSize = Number(sizeMatch[1]);
  pages.__pageSize = pageSize;

  for (const line of out.split('\n')) {
    const m = line.match(/^([^:]+):\s+([\d]+)/);
    if (!m) continue;
    pages[m[1].trim().toLowerCase()] = Number(m[2]);
  }
  return pages;
}

async function readDarwinRam(): Promise<HostRamSample | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/vm_stat', [], { timeout: 2000 });
    const pages = parseVmStatPages(stdout);
    const pageSize = pages.__pageSize || 4096;
    const free = pages['pages free'] ?? 0;
    const inactive = pages['pages inactive'] ?? 0;
    const speculative = pages['pages speculative'] ?? 0;
    const purgeable = pages['pages purgeable'] ?? 0;
    // Activity Monitor–style used ≈ total − reclaimable
    const availablePages = free + inactive + speculative + purgeable;
    const totalBytes = os.totalmem();
    const availableBytes = availablePages * pageSize;
    const usedBytes = Math.max(0, Math.min(totalBytes, totalBytes - availableBytes));
    return { totalBytes, usedBytes, source: 'vm_stat' };
  } catch {
    return null;
  }
}

export async function sampleHostRam(): Promise<HostRamSample> {
  const linux = await readLinuxRam();
  if (linux) return linux;
  const darwin = await readDarwinRam();
  if (darwin) return darwin;
  const totalBytes = os.totalmem();
  const usedBytes = Math.max(0, totalBytes - os.freemem());
  return { totalBytes, usedBytes, source: 'os.freemem' };
}
