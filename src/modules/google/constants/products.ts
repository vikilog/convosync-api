import type { GoogleProductKey } from '@prisma/client';

export type GoogleProductDefinition = {
  key: GoogleProductKey;
  label: string;
  description: string;
  futureUse: string[];
};

export const GOOGLE_PRODUCTS: GoogleProductDefinition[] = [
  {
    key: 'calendar',
    label: 'Google Calendar',
    description: 'Schedule events, check availability, and sync appointments.',
    futureUse: ['AI Scheduling', 'Journey Reminders', 'Appointment Sync'],
  },
  {
    key: 'business_profile',
    label: 'Google Business Profile',
    description: 'Sync locations, hours, reviews, and local business metrics.',
    futureUse: ['AI Review Replies', 'Review Request Journeys', 'Local Business Analytics'],
  },
  {
    key: 'sheets',
    label: 'Google Sheets',
    description: 'Read, write, and append rows across worksheets.',
    futureUse: ['CRM Sync', 'Lead Import', 'Campaign Export', 'Journey Triggers'],
  },
  {
    key: 'drive',
    label: 'Google Drive',
    description: 'Browse files, select folders, and track document changes.',
    futureUse: ['AI Knowledge Source', 'Document Search', 'RAG Integration'],
  },
  {
    key: 'gmail',
    label: 'Gmail',
    description: 'Send and read messages with shared inbox support.',
    futureUse: ['AI Email Assistant', 'Unified Inbox'],
  },
  {
    key: 'meet',
    label: 'Google Meet',
    description: 'Create meetings, generate Meet links, and attach to calendar events.',
    futureUse: ['Appointment Booking', 'Course Sessions', 'Consultations'],
  },
];

export const GOOGLE_PRODUCT_BY_KEY = Object.fromEntries(
  GOOGLE_PRODUCTS.map((p) => [p.key, p])
) as Record<GoogleProductKey, GoogleProductDefinition>;
