import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Message",
      "JourneyEnrollment",
      "Conversation",
      "Contact",
      "Campaign",
      "Journey",
      "AiAgent",
      "Template",
      "WhatsAppPhoneAccount",
      "WorkspaceMembership",
      "User",
      "Workspace"
    RESTART IDENTITY CASCADE;
  `);
  console.log('Database emptied. Sign up at the app to create your first company.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
