/**
 * آزمون‌های واحد اعتبارسنجی اسکیما و قوانین قطعی داده
 * منطبق بر معیارهای پذیرش MASTER-15 (از SCHEMA-01 تا SCHEMA-06)
 */

import { describe, expect, it } from 'bun:test';
import { Space } from '../core/types.js';
import {
  calculateHoldExpiration,
  generateLinkCode,
  isRequestAllowedByCutoff,
  validateForeignPilgrimBooking,
  validateLinkCode,
  validateSpaceCapacity
} from '../db/schema.js';

describe('MASTER-15 — آزمون‌های اعتبارسنجی اسکیما و طرح داده', () => {

  // SCHEMA-02: انقضای ۲۴ ساعته کد اتصال و یک‌بارمصرف بودن آن (DEC-0040)
  describe('SCHEMA-02: کد اتصال حساب‌ها (link_codes)', () => {
    it('کد صادرشده باید دقیقا ۲۴ ساعت بعد منقضی شود', () => {
      const now = new Date('2026-10-17T12:00:00Z');
      const link = generateLinkCode('person-1', '123456', now);

      expect(link.code).toBe('123456');
      expect(link.usedAt).toBeNull();
      // دقیقاً ۲۴ ساعت بعد
      expect(link.expiresAt.toISOString()).toBe('2026-10-18T12:00:00.000Z');
    });

    it('کد در بازه ۲۴ ساعته معتبر است', () => {
      const now = new Date('2026-10-17T12:00:00Z');
      const link = generateLinkCode('person-1', '123456', now);

      const checkTime = new Date('2026-10-18T11:59:59Z'); // ۲۳ ساعت و ۵۹ دقیقه بعد
      const result = validateLinkCode(link, checkTime);
      expect(result.isValid).toBe(true);
    });

    it('کد پس از ۲۴ ساعت باید منقضی اعلام شود', () => {
      const now = new Date('2026-10-17T12:00:00Z');
      const link = generateLinkCode('person-1', '123456', now);

      const afterExpired = new Date('2026-10-18T12:00:01Z');
      const result = validateLinkCode(link, afterExpired);
      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('CODE_EXPIRED');
    });

    it('کد مصرف‌شده نباید دوباره قابل استفاده باشد (یک‌بارمصرف)', () => {
      const now = new Date('2026-10-17T12:00:00Z');
      const link = generateLinkCode('person-1', '123456', now);
      link.usedAt = new Date('2026-10-17T13:00:00Z'); // قبلا مصرف شده

      const result = validateLinkCode(link, new Date('2026-10-17T14:00:00Z'));
      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('CODE_ALREADY_USED');
    });
  });

  // SCHEMA-03: مهلت ۲۴ ساعته نگه‌داشت ظرفیت در ماشین وضعیت (DEC-0025, DEC-0035)
  describe('SCHEMA-03: مهلت نگه‌داشت ظرفیت (hold_expires_at)', () => {
    it('مهلت گام انتظار باید دقیقاً ۲۴ ساعت پس از شروع گام تنظیم شود', () => {
      const stepStart = new Date('2026-10-17T10:00:00Z');
      const holdExpires = calculateHoldExpiration(stepStart);

      expect(holdExpires.getTime() - stepStart.getTime()).toBe(24 * 60 * 60 * 1000);
      expect(holdExpires.toISOString()).toBe('2026-10-18T10:00:00.000Z');
    });
  });

  // SCHEMA-04: قانون مرز ۷ روز پیش از ورود (DEC-0033, DEC-0034)
  describe('SCHEMA-04: مرز ۷ روز پیش از ورود (Cutoff Date)', () => {
    it('برای ورود ۲۰ آبان (2026-11-10)، آخرین روز مجاز ۱۳ آبان (2026-11-03) است', () => {
      const checkInDate = '2026-11-10';

      // درخواست در ۱۳ آبان مجاز است
      const req13 = isRequestAllowedByCutoff(checkInDate, '2026-11-03');
      expect(req13.isAllowed).toBe(true);
      expect(req13.lastAllowedDate).toBe('2026-11-03');

      // درخواست در ۱۴ آبان غیرمجاز است
      const req14 = isRequestAllowedByCutoff(checkInDate, '2026-11-04');
      expect(req14.isAllowed).toBe(false);
    });
  });

  // SCHEMA-05: ظرفیت اسمی اتاق بدون استثنای کودک و تفکیک جنسیتی سالن (DEC-0007, DEC-0027)
  describe('SCHEMA-05: اعتبارسنجی ظرفیت اتاق و سالن', () => {
    const privateRoom4: Space = {
      id: 'space-room-4',
      placeId: 'mokab-1',
      spaceType: 'PRIVATE_ROOM',
      title: 'اتاق ۴ نفره شماره ۱۰۱',
      genderGroup: 'ALL',
      nominalCapacity: 4,
      createdAt: new Date()
    };

    it('گروه ۵ نفره شامل کودک در اتاق ۴ نفره جا نمی‌شود (کودک شمرده می‌شود)', () => {
      // ۳ بزرگسال + ۲ کودک = ۵ نفر
      const result = validateSpaceCapacity(privateRoom4, 1, 2, 2);
      expect(result.isAllowed).toBe(false);
      expect(result.reason).toContain('EXCEEDS_ROOM_CAPACITY');
    });

    it('گروه ۴ نفره شامل کودک در اتاق ۴ نفره مجاز است', () => {
      // ۲ بزرگسال + ۲ کودک = ۴ نفر
      const result = validateSpaceCapacity(privateRoom4, 1, 1, 2);
      expect(result.isAllowed).toBe(true);
    });

    it('سالن عمومی آقایان نباید زائر خانم بپذیرد', () => {
      const menHall: Space = {
        id: 'space-hall-men',
        placeId: 'mokab-1',
        spaceType: 'PUBLIC_HALL',
        title: 'سالن الف',
        genderGroup: 'MEN',
        nominalCapacity: 50,
        createdAt: new Date()
      };

      const result = validateSpaceCapacity(menHall, 2, 1, 0); // ۱ خانم دارد
      expect(result.isAllowed).toBe(false);
      expect(result.reason).toBe('GENDER_MISMATCH_MEN_ONLY');
    });
  });

  // SCHEMA-06: زائر خارجی بدون پرداخت و با تصویر گذرنامه (DEC-0032, DEC-0036)
  describe('SCHEMA-06: شرایط رزرو زائر خارجی', () => {
    it('زائر خارجی با تصویر گذرنامه و مبلغ صفر در سامانه مجاز است', () => {
      const result = validateForeignPilgrimBooking(true, true, 0);
      expect(result.isAllowed).toBe(true);
    });

    it('زائر خارجی در صورت داشتن مبلغ پرداختی در سامانه رد می‌شود', () => {
      const result = validateForeignPilgrimBooking(true, true, 50000);
      expect(result.isAllowed).toBe(false);
      expect(result.reason).toBe('FOREIGN_PILGRIM_CANNOT_PAY_IN_APP');
    });

    it('زائر خارجی بدون گذرنامه رد می‌شود', () => {
      const result = validateForeignPilgrimBooking(true, false, 0);
      expect(result.isAllowed).toBe(false);
      expect(result.reason).toBe('PASSPORT_IMAGE_REQUIRED');
    });
  });

});
