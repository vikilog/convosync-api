import assert from 'node:assert/strict';
import { sampleHostCpuPct, sampleHostRam } from './hostMetrics.js';

const ram = await sampleHostRam();
assert.ok(ram.totalBytes > 0, 'total RAM');
assert.ok(ram.usedBytes >= 0 && ram.usedBytes <= ram.totalBytes, 'used RAM in range');
assert.ok(ram.source === 'vm_stat' || ram.source === 'meminfo' || ram.source === 'os.freemem');

const cpu1 = await sampleHostCpuPct();
const cpu2 = await sampleHostCpuPct();
assert.ok(cpu1.cores >= 1);
assert.ok(cpu2.cpuPct >= 0 && cpu2.cpuPct <= 100);

console.log(
  `hostMetrics: ok · ram ${Math.round(ram.usedBytes / 1024 / 1024)}/${Math.round(ram.totalBytes / 1024 / 1024)} MB (${ram.source}) · cpu ${cpu2.cpuPct}%`
);
