/**
 * ponytail: minimal self-check for platform audit helper + list mapping.
 * Run: npx tsx backend/scripts/platform-audit-self-check.ts
 */
import { prisma } from '../src/lib/prisma.js';
import {
  auditActionLabel,
  listPlatformAuditLogs,
  mapAuditLogRow,
  PLATFORM_AUDIT_ACTIONS,
  recordAuditEvent,
} from '../src/services/platformAudit.js';

async function main() {
  const action = PLATFORM_AUDIT_ACTIONS.COUPON_CREATE;
  recordAuditEvent({
    action,
    actor: { email: 'self-check@convosync.test', role: 'super_admin' },
    entityType: 'coupon',
    entityId: 'self-check-coupon',
    category: 'billing',
    severity: 'info',
    metadata: {
      targetLabel: 'SELF_CHECK',
      details: 'platform audit self-check event',
    },
    ipAddress: '127.0.0.1',
  });

  await new Promise((r) => setTimeout(r, 250));

  const row = await prisma.platformAuditLog.findFirst({
    where: { entityId: 'self-check-coupon' },
    orderBy: { createdAt: 'desc' },
  });

  if (!row) throw new Error('expected audit row after recordAuditEvent');

  const mapped = mapAuditLogRow(row);
  if (mapped.action !== auditActionLabel(action)) {
    throw new Error(`label mismatch: ${mapped.action}`);
  }
  if (mapped.details !== 'platform audit self-check event') {
    throw new Error(`details mismatch: ${mapped.details}`);
  }

  const listed = await listPlatformAuditLogs({
    page: 1,
    pageSize: 5,
    search: 'self-check@convosync.test',
  });
  if (!listed.logs.some((l) => l.id === row.id)) {
    throw new Error('listed logs missing self-check row');
  }

  await prisma.platformAuditLog.delete({ where: { id: row.id } });

  console.log('platform-audit self-check OK');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
