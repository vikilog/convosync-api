import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findUniqueState, createState, updateState, findUniqueUser, redisGet, redisSet, redisDel } =
  vi.hoisted(() => ({
    findUniqueState: vi.fn(),
    createState: vi.fn(),
    updateState: vi.fn(),
    findUniqueUser: vi.fn(),
    redisGet: vi.fn(),
    redisSet: vi.fn(),
    redisDel: vi.fn(),
  }));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    userSecurityState: {
      findUnique: findUniqueState,
      create: createState,
      update: updateState,
    },
    user: { findUnique: findUniqueUser },
  },
}));

vi.mock('../lib/redis.js', () => ({
  getRedis: () => ({ get: redisGet, set: redisSet, del: redisDel }),
}));

import {
  blacklistJti,
  bumpTokenVersion,
  getUserTokenVersion,
  JtiBlacklistUnavailableError,
} from './userSecurity.js';

describe('userSecurity helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    findUniqueState.mockReset();
    createState.mockReset();
    updateState.mockReset();
    findUniqueUser.mockReset();
    redisGet.mockReset();
    redisSet.mockReset();
    redisDel.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('blacklistJti', () => {
    it('stores jti until JWT exp', async () => {
      redisSet.mockResolvedValue('OK');
      const exp = Math.floor(Date.now() / 1000) + 90;
      await blacklistJti('abc', exp);
      expect(redisSet).toHaveBeenCalledWith('blacklist:jti:abc', '1', 'EX', 90);
    });

    it('clamps TTL to at least 1s when exp is in the past', async () => {
      redisSet.mockResolvedValue('OK');
      await blacklistJti('old', Math.floor(Date.now() / 1000) - 30);
      expect(redisSet).toHaveBeenCalledWith('blacklist:jti:old', '1', 'EX', 1);
    });

    it('throws JtiBlacklistUnavailableError when Redis cannot store', async () => {
      redisSet.mockRejectedValue(new Error('down'));
      await expect(blacklistJti('abc', Math.floor(Date.now() / 1000) + 10)).rejects.toBeInstanceOf(
        JtiBlacklistUnavailableError
      );
    });
  });

  describe('getUserTokenVersion', () => {
    it('returns cached tokenVersion without hitting Postgres', async () => {
      redisGet.mockResolvedValue('7');
      await expect(getUserTokenVersion('u1')).resolves.toBe(7);
      expect(findUniqueState).not.toHaveBeenCalled();
    });

    it('loads Postgres on cache miss and writes the cache', async () => {
      redisGet.mockResolvedValue(null);
      findUniqueState.mockResolvedValue({ tokenVersion: 3 });
      redisSet.mockResolvedValue('OK');
      await expect(getUserTokenVersion('u1')).resolves.toBe(3);
      expect(redisSet).toHaveBeenCalledWith('tokenVersion:user:u1', '3', 'EX', 5 * 60);
    });

    it('falls back to Postgres when Redis get fails', async () => {
      redisGet.mockRejectedValue(new Error('down'));
      findUniqueState.mockResolvedValue({ tokenVersion: 4 });
      redisSet.mockResolvedValue('OK');
      await expect(getUserTokenVersion('u1')).resolves.toBe(4);
    });

    it('treats non-numeric cache as a miss', async () => {
      redisGet.mockResolvedValue('nope');
      findUniqueState.mockResolvedValue({ tokenVersion: 1 });
      redisSet.mockResolvedValue('OK');
      await expect(getUserTokenVersion('u1')).resolves.toBe(1);
    });
  });

  describe('bumpTokenVersion', () => {
    it('increments tokenVersion, records reason, and invalidates cache', async () => {
      findUniqueState.mockResolvedValue({ tokenVersion: 1 });
      updateState.mockResolvedValue({ tokenVersion: 2 });
      redisDel.mockResolvedValue(1);
      await expect(bumpTokenVersion('u1', 'logout_all')).resolves.toBe(2);
      expect(updateState).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        data: { tokenVersion: { increment: 1 }, updatedReason: 'logout_all' },
      });
      expect(redisDel).toHaveBeenCalledWith('tokenVersion:user:u1');
    });

    it('ensures a missing security row before increment', async () => {
      findUniqueState.mockResolvedValueOnce(null);
      findUniqueUser.mockResolvedValue({ id: 'u1' });
      createState.mockResolvedValue({ tokenVersion: 0, updatedReason: 'ensure' });
      updateState.mockResolvedValue({ tokenVersion: 1 });
      redisDel.mockResolvedValue(1);
      await expect(bumpTokenVersion('u1', 'password_change')).resolves.toBe(1);
      expect(createState).toHaveBeenCalledWith({
        data: { userId: 'u1', tokenVersion: 0, updatedReason: 'ensure' },
      });
    });
  });
});
