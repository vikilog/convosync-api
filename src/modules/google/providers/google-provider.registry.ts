import type { GoogleProductKey } from '@prisma/client';
import type { GoogleService } from '../services/google.service.js';
import type { BaseGoogleProvider } from './base.provider.js';
import { GoogleCalendarProvider } from './calendar.provider.js';
import { GoogleBusinessProfileProvider } from './business-profile.provider.js';
import { GoogleSheetsProvider } from './sheets.provider.js';
import { GoogleDriveProvider } from './drive.provider.js';
import { GoogleGmailProvider } from './gmail.provider.js';
import { GoogleMeetProvider } from './meet.provider.js';

export class GoogleProviderRegistry {
  private readonly providers: Map<GoogleProductKey, BaseGoogleProvider>;

  constructor(googleService: GoogleService) {
    this.providers = new Map<GoogleProductKey, BaseGoogleProvider>([
      ['calendar', new GoogleCalendarProvider(googleService)],
      ['business_profile', new GoogleBusinessProfileProvider(googleService)],
      ['sheets', new GoogleSheetsProvider(googleService)],
      ['drive', new GoogleDriveProvider(googleService)],
      ['gmail', new GoogleGmailProvider(googleService)],
      ['meet', new GoogleMeetProvider(googleService)],
    ]);
  }

  get(product: GoogleProductKey): BaseGoogleProvider {
    const provider = this.providers.get(product);
    if (!provider) throw new Error(`Unknown Google product: ${product}`);
    return provider;
  }

  list(): BaseGoogleProvider[] {
    return Array.from(this.providers.values());
  }
}
