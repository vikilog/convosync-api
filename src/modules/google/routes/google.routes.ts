import type { FastifyInstance } from 'fastify';
import { prisma } from '../../../index.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { GoogleController } from '../controllers/google.controller.js';
import { GbpController } from '../controllers/gbp.controller.js';
import { initGoogleModule } from '../container.js';

export default async function googleRoutes(fastify: FastifyInstance) {
  initGoogleModule(prisma);
  const controller = new GoogleController();
  const gbpController = new GbpController();
  const auth = companyAuth;

  fastify.get('/oauth/state', auth, controller.oauthState);
  fastify.post('/connect', auth, controller.connectAccount);

  fastify.get('/connections', auth, controller.listConnections);
  fastify.delete('/connections/:id', auth, controller.disconnectConnection);
  fastify.post('/connections/:id/refresh', auth, controller.refreshConnection);

  fastify.get('/products', auth, controller.listProducts);
  fastify.post('/products/:product/connect', auth, controller.connectProduct);
  fastify.post('/products/:product/disconnect', auth, controller.disconnectProduct);
  fastify.post('/products/:product/sync', auth, controller.syncProduct);
  fastify.get(
    '/products/:product/connections/:connectionId/permissions',
    auth,
    controller.validatePermissions
  );

  fastify.post('/calendar/events', auth, controller.calendarCreateEvent);
  fastify.post('/calendar/events/list', auth, controller.calendarListEvents);
  fastify.patch('/calendar/events', auth, controller.calendarUpdateEvent);
  fastify.delete('/calendar/events', auth, controller.calendarDeleteEvent);
  fastify.post('/calendar/calendars', auth, controller.calendarListCalendars);
  fastify.post('/calendar/availability', auth, controller.calendarAvailability);

  fastify.post('/sheets/spreadsheets/list', auth, controller.sheetsList);
  fastify.post('/sheets/spreadsheets/get', auth, controller.sheetsGet);
  fastify.post('/sheets/read', auth, controller.sheetsRead);
  fastify.post('/sheets/write', auth, controller.sheetsWrite);
  fastify.post('/sheets/append', auth, controller.sheetsAppend);

  fastify.post('/drive/browse', auth, controller.driveBrowse);
  fastify.post('/drive/files/get', auth, controller.driveGetFile);
  fastify.post('/drive/files/preview', auth, controller.drivePreviewFile);

  fastify.post('/gmail/send', auth, controller.gmailSend);
  fastify.post('/gmail/messages', auth, controller.gmailRead);
  fastify.post('/gmail/messages/get', auth, controller.gmailGetMessage);

  fastify.post('/meet/meetings/list', auth, controller.meetList);
  fastify.post('/meet/meetings/cancel', auth, controller.meetCancel);
  fastify.post('/meet/create', auth, controller.meetCreate);

  // GBP cache-first API (reads PostgreSQL / Redis only)
  fastify.get('/business-profile/accounts', auth, gbpController.listAccounts);
  fastify.get('/business-profile/locations', auth, gbpController.listLocations);
  fastify.get(
    '/business-profile/locations/:locationId/reviews',
    auth,
    gbpController.listReviews
  );
  fastify.get(
    '/business-profile/locations/:locationId/metrics',
    auth,
    gbpController.listMetrics
  );
  fastify.post('/business-profile/sync', auth, gbpController.enqueueSync);
  fastify.get('/business-profile/sync/status', auth, gbpController.syncStatus);
  fastify.get('/business-profile/sync/logs', auth, gbpController.syncLogs);

  /** @deprecated Use GET /business-profile/locations — cache only, no Google API */
  fastify.post('/business-profile/locations', auth, gbpController.cachedLocationsLegacy);
}
