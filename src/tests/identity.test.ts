/**
 * آزمون‌های واحد ماژول هویت و پیوند حساب (MASTER-16)
 * معیارهای پذیرش ID-01 تا ID-06
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { IdentityService } from '../core/identity/identity-service.js';

describe('MASTER-16 — آزمون‌های هویت و پیوند حساب زائر و موکب‌دار', () => {
  let identityService: IdentityService;

  beforeEach(() => {
    identityService = new IdentityService();
  });

  // ID-01: ساخت حساب اولیه بدون شماره تلفن (DEC-0043)
  it('ID-01: ساخت حساب اولیه با شناسه پیام‌رسان بدون درخواست شماره تلفن', async () => {
    const { person, channelAccount, isNew } = await identityService.getOrCreateAccount('TELEGRAM', 'tg-user-1001');

    expect(isNew).toBe(true);
    expect(person.id).toBeDefined();
    // طبق DEC-0043 در ورود اولیه شماره نباید خواسته شود
    expect(person.phoneNumber).toBeNull();
    expect(channelAccount.channelType).toBe('TELEGRAM');
    expect(channelAccount.channelUserId).toBe('tg-user-1001');
    expect(channelAccount.personId).toBe(person.id);
  });

  // ID-02: بازیابی حساب در ورود مجدد بدون تکرار (DEC-0003)
  it('ID-02: ورود مجدد همان کاربر باید همان حساب شخص را بازگرداند', async () => {
    const firstLogin = await identityService.getOrCreateAccount('BALE', 'bale-user-2002');
    expect(firstLogin.isNew).toBe(true);

    const secondLogin = await identityService.getOrCreateAccount('BALE', 'bale-user-2002');
    expect(secondLogin.isNew).toBe(false);
    expect(secondLogin.person.id).toBe(firstLogin.person.id);
    expect(secondLogin.channelAccount.id).toBe(firstLogin.channelAccount.id);
  });

  // ID-03: صدور کد پیوند با انقضای دقیق ۲۴ ساعته (DEC-0040)
  it('ID-03: صدور کد پیوند ۲۴ ساعته', async () => {
    const { person } = await identityService.getOrCreateAccount('TELEGRAM', 'tg-user-1001');
    const issueTime = new Date('2026-10-17T12:00:00Z');

    const linkCode = await identityService.generateLinkingCode(person.id, issueTime);

    expect(linkCode.code).toBeDefined();
    expect(linkCode.code.length).toBe(6);
    expect(linkCode.personId).toBe(person.id);
    expect(linkCode.usedAt).toBeNull();
    expect(linkCode.expiresAt.toISOString()).toBe('2026-10-18T12:00:00.000Z');
  });

  // ID-04: پیوند موفق دو پیام‌رسان به یک حساب مرکزی (DEC-0018, DEC-0040)
  it('ID-04: مصرف کد معتبر در بله و اتصال به حساب تلگرام موجود', async () => {
    // مرحله ۱: کاربر در تلگرام حساب دارد
    const tgAccount = await identityService.getOrCreateAccount('TELEGRAM', 'tg-user-1001');
    const issueTime = new Date('2026-10-17T12:00:00Z');
    const linkCode = await identityService.generateLinkingCode(tgAccount.person.id, issueTime);

    // مرحله ۲: کاربر کد را در بله وارد می‌کند (یک ساعت بعد)
    const redeemTime = new Date('2026-10-17T13:00:00Z');
    const redeemResult = await identityService.redeemLinkingCode('BALE', 'bale-user-2002', linkCode.code, redeemTime);

    expect(redeemResult.success).toBe(true);
    expect(redeemResult.person?.id).toBe(tgAccount.person.id);

    // مرحله ۳: بررسی اینکه اکنون هر دو کانال به همان personId متصل‌اند
    const linked = await identityService.getLinkedChannels(tgAccount.person.id);
    expect(linked.length).toBe(2);

    const types = linked.map(l => l.channelType);
    expect(types).toContain('TELEGRAM');
    expect(types).toContain('BALE');
  });

  // ID-05: رد کد منقضی شده یا مصرف شده (DEC-0040)
  it('ID-05: رد قطعی کد منقضی‌شده و کد قبلاً مصرف‌شده', async () => {
    const tgAccount = await identityService.getOrCreateAccount('TELEGRAM', 'tg-user-1001');
    const issueTime = new Date('2026-10-17T12:00:00Z');
    const linkCode = await identityService.generateLinkingCode(tgAccount.person.id, issueTime);

    // آزمون ۵.۱: تلاش پس از ۲۴ ساعت
    const expiredTime = new Date('2026-10-18T12:01:00Z');
    const expiredResult = await identityService.redeemLinkingCode('BALE', 'bale-user-2002', linkCode.code, expiredTime);
    expect(expiredResult.success).toBe(false);
    expect(expiredResult.error).toBe('CODE_EXPIRED');

    // آزمون ۵.۲: مصرف کد در بازه معتبر
    const validTime = new Date('2026-10-17T14:00:00Z');
    const firstRedeem = await identityService.redeemLinkingCode('BALE', 'bale-user-2002', linkCode.code, validTime);
    expect(firstRedeem.success).toBe(true);

    // آزمون ۵.۳: تلاش برای استفاده مجدد از همان کد (باید رد شود)
    const secondRedeem = await identityService.redeemLinkingCode('BALE', 'bale-user-3003', linkCode.code, validTime);
    expect(secondRedeem.success).toBe(false);
    expect(secondRedeem.error).toBe('CODE_ALREADY_USED');
  });

  // ID-06: جلوگیری از تعارض حسابی (اگر کانال مقصد قبلاً به حساب دیگری وصل شده باشد)
  it('ID-06: جلوگیری از اتصال در صورت وجود تعارض حساب', async () => {
    const userA = await identityService.getOrCreateAccount('TELEGRAM', 'tg-user-A');
    const linkCode = await identityService.generateLinkingCode(userA.person.id);

    // تلاش برای اتصال مجدد همان کانال تلگرام به همان شخص
    const selfLink = await identityService.redeemLinkingCode('TELEGRAM', 'tg-user-A', linkCode.code);
    expect(selfLink.success).toBe(false);
    expect(selfLink.error).toContain('ALREADY_LINKED');
  });

  // آزمون تکمیلی: ثبت شماره تماس فقط هنگام رزرو (DEC-0043)
  it('آزمون تکمیلی: ثبت شماره تماس هنگام ثبت رزرو', async () => {
    const { person } = await identityService.getOrCreateAccount('TELEGRAM', 'tg-user-1001');
    expect(person.phoneNumber).toBeNull();

    const updated = await identityService.recordPhoneNumberAtBooking(person.id, '09123456789');
    expect(updated.phoneNumber).toBe('09123456789');

    const retrieved = await identityService.getPersonById(person.id);
    expect(retrieved?.phoneNumber).toBe('09123456789');
  });
});
