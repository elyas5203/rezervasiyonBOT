/**
 * آزمون‌های واحد درگاه‌های پیام‌رسان (تلگرام و بله) و وب‌ویو مدیریت
 * انطباق با مستر ۲۲ (MASTER-22) و تصمیم‌های DEC-0003, DEC-0004, DEC-0012, DEC-0016, DEC-0028, DEC-0041
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  MessageDeduplicator,
  TelegramAdapter,
  BaleAdapter,
} from '../channels/channel-adapter';
import { TelegramBotWorker } from '../channels/telegram-worker';
import { OutboundMessage } from '../channels/types';
import {
  AdminAuthService,
  AdminManagementService,
  AdminUser,
} from '../admin/admin-service';
import {
  InventoryService,
  InMemoryInventoryRepository,
} from '../core/inventory/inventory-service';
import {
  ReservationService,
} from '../core/reservation/reservation-service';
import {
  CapacityService,
} from '../core/capacity/capacity-service';

describe('MASTER-22 — آزمون‌های درگاه‌های پیام‌رسان (تلگرام و بله) و احراز هویت وب‌ویو مدیریت', () => {
  let deduplicator: MessageDeduplicator;
  let telegramAdapter: TelegramAdapter;
  let baleAdapter: BaleAdapter;
  let authService: AdminAuthService;
  let inventoryService: InventoryService;
  let reservationService: ReservationService;
  let adminService: AdminManagementService;

  beforeEach(() => {
    deduplicator = new MessageDeduplicator(10000); // 10 ثانیه TTL
    telegramAdapter = new TelegramAdapter(deduplicator);
    baleAdapter = new BaleAdapter(deduplicator);

    const invRepo = new InMemoryInventoryRepository();
    inventoryService = new InventoryService(invRepo);

    const capacityService = new CapacityService();
    reservationService = new ReservationService(capacityService);

    authService = new AdminAuthService();
    adminService = new AdminManagementService(authService, inventoryService, reservationService);
  });

  // ----------------------------------------------------
  // ۱. آزمون‌های درگاه پیام‌رسان (Channel Adapters)
  // ----------------------------------------------------
  test('CH-01: جلوگیری از پردازش تکراری پیام یا کلیک دکمه در تلگرام و بله (Deduplication / Idempotency)', () => {
    const rawTelegramUpdate = {
      update_id: 100234,
      message: {
        message_id: 554,
        chat: { id: 123456 },
        from: { id: 123456 },
        text: 'استعلام ظرفیت کربلا',
      },
    };

    const inbound = telegramAdapter.normalizeInbound(rawTelegramUpdate, 'TRAVELER_BOT');
    expect(deduplicator.isDuplicate(inbound.idempotencyKey)).toBe(false);

    // علامت‌گذاری پردازش
    deduplicator.markProcessed(inbound.idempotencyKey);

    // ارسال مجدد همان پیام بر اثر تأخیر یا قطعی شبکه
    const duplicateInbound = telegramAdapter.normalizeInbound(rawTelegramUpdate, 'TRAVELER_BOT');
    expect(deduplicator.isDuplicate(duplicateInbound.idempotencyKey)).toBe(true);

    // تست برای بله
    const rawBaleCallback = {
      update_id: 998811,
      callback_query: {
        id: 'cb_7766',
        from: { id: 887766 },
        data: 'ACTION_CONFIRM_BOOKING',
      },
    };

    const baleInbound = baleAdapter.normalizeInbound(rawBaleCallback, 'TRAVELER_BOT');
    expect(deduplicator.isDuplicate(baleInbound.idempotencyKey)).toBe(false);
    deduplicator.markProcessed(baleInbound.idempotencyKey);

    const duplicateBaleInbound = baleAdapter.normalizeInbound(rawBaleCallback, 'TRAVELER_BOT');
    expect(deduplicator.isDuplicate(duplicateBaleInbound.idempotencyKey)).toBe(true);
  });

  test('CH-02: تبدیل دکمه‌های شیشه‌ای اینلاین به ساختار استاندارد تلگرام و بله (DEC-0003, DEC-0028)', () => {
    const outbound: OutboundMessage = {
      channel: 'TELEGRAM',
      chatId: '123456',
      text: 'ورود مدیر به پنل وب‌ویو',
      inlineKeyboard: [
        [
          { text: '🌐 ورود به پنل وب‌ویو', webAppUrl: 'https://admin.mokab-reserve.ir/login?token=xyz' },
          { text: '❌ انصراف', callbackData: 'ADMIN_CANCEL' },
        ],
      ],
    };

    const telegramFormatted = telegramAdapter.formatOutbound(outbound);
    expect(telegramFormatted.reply_markup.inline_keyboard).toBeDefined();
    expect(telegramFormatted.reply_markup.inline_keyboard[0][0].web_app.url).toBe('https://admin.mokab-reserve.ir/login?token=xyz');
    expect(telegramFormatted.reply_markup.inline_keyboard[0][1].callback_data).toBe('ADMIN_CANCEL');

    const baleOutbound: OutboundMessage = {
      channel: 'BALE',
      chatId: '987654',
      text: 'پیوند حساب',
      inlineKeyboard: [
        [
          { text: '🔗 پیوند دو پیام‌رسان', callbackData: 'LINK_ACCOUNT' },
          { text: 'پایگاه اطلاع‌رسانی', url: 'https://mokab-reserve.ir' },
        ],
      ],
    };

    const baleFormatted = baleAdapter.formatOutbound(baleOutbound);
    expect(baleFormatted.reply_markup.inline_keyboard).toBeDefined();
    expect(baleFormatted.reply_markup.inline_keyboard[0][0].callback_data).toBe('LINK_ACCOUNT');
    expect(baleFormatted.reply_markup.inline_keyboard[0][1].url).toBe('https://mokab-reserve.ir');
  });

  test('CH-03: عدم شکست تراکنش در صورت بروز خطای ارسال در درگاه پیام‌رسان (DEC-0016)', async () => {
    telegramAdapter.setSimulateFailure(true);
    baleAdapter.setSimulateFailure(true);

    const outboundMsg: OutboundMessage = {
      channel: 'TELEGRAM',
      chatId: '123456',
      text: 'اعلان وضعیت رزرو',
    };

    const tgResult = await telegramAdapter.sendOutbound(outboundMsg);
    expect(tgResult).toBe(false); // خطا مدیریت شده و exception بالا نمی‌آید

    const baleResult = await baleAdapter.sendOutbound(outboundMsg);
    expect(baleResult).toBe(false);
  });

  // ----------------------------------------------------
  // ۲. آزمون‌های احراز هویت وب‌ویو مرورگر (Admin WebView Auth)
  // ----------------------------------------------------
  test('ADM-01: ورود مدیر به پنل وب‌ویو با توکن یک‌بارمصرف و مهار حمله بازپخش (DEC-0028)', async () => {
    // صدور توکن برای مدیر اصلی
    const token = await authService.generateLoginToken('admin-super-001', 300);
    expect(token).toBeDefined();
    expect(token.startsWith('magic-')).toBe(true);

    // ورود اول: موفق و دریافت نشست
    const session = await authService.exchangeTokenForSession(token);
    expect(session.sessionId).toBeDefined();
    expect(session.role).toBe('SUPER_ADMIN');
    expect(session.isValid).toBe(true);

    // اعتبارسنجی نشست
    const adminUser = await authService.validateSession(session.sessionId);
    expect(adminUser.id).toBe('admin-super-001');

    // تلاش برای استفاده مجدد از همان توکن (حمله بازپخش)
    await expect(authService.exchangeTokenForSession(token)).rejects.toThrow('TOKEN_ALREADY_USED');

    // توکن منقضی‌شده با TTL صفر
    const expiredToken = await authService.generateLoginToken('admin-super-001', -1);
    await expect(authService.exchangeTokenForSession(expiredToken)).rejects.toThrow('TOKEN_EXPIRED');
  });

  test('ADM-02: بررسی و تأیید موکب توسط ادمین منصوب و ثبت لاگ ممیزی (DEC-0004, DEC-0041)', async () => {
    // ۱. ایجاد یک ادمین منصوب
    const appointedAdmin: AdminUser = {
      id: 'admin-app-002',
      displayName: 'ادمین بازبینی پرونده‌ها',
      role: 'APPOINTED_ADMIN',
      isActive: true,
      createdAt: new Date(),
    };
    await authService.registerAdmin(appointedAdmin);

    // ۲. ورود ادمین به پنل
    const token = await authService.generateLoginToken(appointedAdmin.id);
    const session = await authService.exchangeTokenForSession(token);

    // ۳. ثبت یک موکب در حالت انتظار
    const mokab = await inventoryService.registerMokabPlace({
      hostPersonId: 'host-101',
      title: 'موکب شهدای نجف',
      city: 'نجف',
      address: 'شارع الرسول',
      contactName: 'حاج احمد',
      contactPhone: '09121111111',
      placePhotoPath: '/photos/place1.jpg',
      responsibilityDocumentPath: '/docs/auth1.pdf',
      supplyType: 'PUBLIC',
      financialModel: 'FREE',
      approvalMode: 'INSTANT',
    });

    // موکب در انتظار نباید در جست‌وجوی عمومی دیده شود (ADM-01 در MASTER-08)
    const publicPlacesBefore = await inventoryService.getApprovedPlaces('نجف');
    expect(publicPlacesBefore.some(p => p.id === mokab.id)).toBe(false);

    // ۴. مشاهده در کارتابل ادمین
    const pendingHosts = await adminService.getPendingHosts(session.sessionId);
    expect(pendingHosts.some(p => p.id === mokab.id)).toBe(true);

    // ۵. تأیید موکب توسط ادمین منصوب با ثبت دلیل مستند
    await adminService.reviewHost(
      session.sessionId,
      mokab.id,
      'APPROVE',
      'مدارک ۴گانه کامل است و محل مورد تأیید قرار گرفت.'
    );

    // موکب اکنون تأیید شده و در جست‌وجوی عمومی نمایان است
    const publicPlacesAfter = await inventoryService.getApprovedPlaces('نجف');
    expect(publicPlacesAfter.some(p => p.id === mokab.id)).toBe(true);

    // ۶. بررسی ثبت لاگ ممیزی (Audit Trail)
    const auditLogs = await adminService.getAuditLogs(session.sessionId);
    const hostAudit = auditLogs.find(a => a.targetId === mokab.id);
    expect(hostAudit).toBeDefined();
    expect(hostAudit?.adminId).toBe(appointedAdmin.id);
    expect(hostAudit?.action).toBe('APPROVE_HOST');
    expect(hostAudit?.reason).toContain('مدارک ۴گانه کامل است');
  });

  test('ADM-03: مهار دسترسی غیرمجاز: ادمین منصوب حق انتصاب ادمین دیگر را ندارد (DEC-0004)', async () => {
    // ادمین منصوب
    const appointedAdmin: AdminUser = {
      id: 'admin-app-003',
      displayName: 'ادمین عادی',
      role: 'APPOINTED_ADMIN',
      isActive: true,
      createdAt: new Date(),
    };
    await authService.registerAdmin(appointedAdmin);

    const tokenAppointed = await authService.generateLoginToken(appointedAdmin.id);
    const sessionAppointed = await authService.exchangeTokenForSession(tokenAppointed);

    // ادمین منصوب سعی می‌کند ادمین جدید ایجاد کند -> باید رد شود
    await expect(
      adminService.appointAdmin(sessionAppointed.sessionId, {
        displayName: 'ادمین غیرمجاز',
      })
    ).rejects.toThrow('FORBIDDEN_ONLY_SUPER_ADMIN_CAN_APPOINT');

    // مدیر اصلی سعی می‌کند ادمین جدید ایجاد کند -> باید موفق شود
    const tokenSuper = await authService.generateLoginToken('admin-super-001');
    const sessionSuper = await authService.exchangeTokenForSession(tokenSuper);

    const newlyAppointed = await adminService.appointAdmin(sessionSuper.sessionId, {
      displayName: 'ادمین جدید معتبر',
      telegramUserId: 'tg_7788',
    });
    expect(newlyAppointed.id).toBeDefined();
    expect(newlyAppointed.role).toBe('APPOINTED_ADMIN');
    expect(newlyAppointed.appointedBy).toBe('admin-super-001');
  });

  test('ADM-04: مرز صریح مالی: ادمین تحت هیچ شرایطی حق تأیید فیش کارت‌به‌کارت را ندارد (DEC-0012, MASTER-08 ADM-03)', async () => {
    const tokenSuper = await authService.generateLoginToken('admin-super-001');
    const sessionSuper = await authService.exchangeTokenForSession(tokenSuper);

    // ادمین تلاش می‌کند فیش واریز را تأیید کند
    await expect(
      adminService.verifyPaymentReceipt(sessionSuper.sessionId, 'res-1234', true)
    ).rejects.toThrow('ADMIN_CANNOT_VERIFY_PAYMENT_RECEIPT');
  });

  test('ADM-05: رسیدگی به تعطیلی اضطراری موکب با حفظ کامل سوابق و بدون حذف رزروها (MASTER-08 ADM-02)', async () => {
    const tokenSuper = await authService.generateLoginToken('admin-super-001');
    const sessionSuper = await authService.exchangeTokenForSession(tokenSuper);

    // ثبت موکب
    const mokab = await inventoryService.registerMokabPlace({
      hostPersonId: 'host-202',
      title: 'موکب امام رضا علیه‌السلام',
      city: 'کربلا',
      address: 'باب القبله',
      contactName: 'حاج رضا',
      contactPhone: '09122222222',
      placePhotoPath: '/photos/place2.jpg',
      responsibilityDocumentPath: '/docs/auth2.pdf',
      supplyType: 'PRIVATE',
      financialModel: 'FREE',
      approvalMode: 'INSTANT',
    });

    // بررسی تعطیلی اضطراری موکب
    const emergencyReport = await adminService.inspectEmergencyClosure(sessionSuper.sessionId, mokab.id);
    expect(emergencyReport.placeId).toBe(mokab.id);
    expect(emergencyReport.affectedReservationsCount).toBe(0);

    // وضعیت موکب به حالت تعلیق رفته است
    const updatedMokab = await inventoryService.getPlaceById(mokab.id);
    expect(updatedMokab?.status).toBe('SUSPENDED');

    // ثبت ممیزی رسیدگی به تعطیلی اضطراری
    const auditLogs = await adminService.getAuditLogs(sessionSuper.sessionId);
    expect(auditLogs.some(a => a.action === 'EMERGENCY_INSPECT' && a.targetId === mokab.id)).toBe(true);
  });

  // ----------------------------------------------------
  // ۴. آزمون‌های ورکر ربات تلگرام (TelegramBotWorker)
  // ----------------------------------------------------
  test('BOT-01: سازنده ورکر زائر و موکب‌دار با تنظیمات مناسب راه‌اندازی و متوقف می‌شود', async () => {
    const travelerWorker = new TelegramBotWorker({
      token: 'mock_traveler_token',
      role: 'TRAVELER',
      adapter: telegramAdapter,
      inventoryService,
    });

    expect(travelerWorker.role).toBe('TRAVELER');
    expect(travelerWorker.token).toBe('mock_traveler_token');

    // شروع و توقف امن با توکن ماک
    await travelerWorker.start();
    travelerWorker.stop();

    const hostWorker = new TelegramBotWorker({
      token: 'mock_host_token',
      role: 'HOST',
      adapter: telegramAdapter,
      inventoryService,
    });

    expect(hostWorker.role).toBe('HOST');
    expect(hostWorker.token).toBe('mock_host_token');
    await hostWorker.start();
    hostWorker.stop();
  });

  test('BOT-02: ارسال پیام خروجی تلگرام ساختار معتبر با parse_mode و کیبورد شیشه‌ای تولید می‌کند', () => {
    const outbound: OutboundMessage = {
      chatId: '123456',
      text: 'سلام زائر گرامی',
      inlineKeyboard: [
        [{ text: '🔍 جست‌وجو', callbackData: 'SEARCH' }],
        [{ text: '🔙 بازگشت', callbackData: 'BACK' }],
      ],
    };

    const formatted = telegramAdapter.formatOutbound(outbound);
    expect(formatted.chat_id).toBe('123456');
    expect(formatted.text).toBe('سلام زائر گرامی');
    expect(formatted.parse_mode).toBe('HTML');
    expect(formatted.reply_markup.inline_keyboard.length).toBe(2);
    expect(formatted.reply_markup.inline_keyboard[0][0].text).toBe('🔍 جست‌وجو');
    expect(formatted.reply_markup.inline_keyboard[0][0].callback_data).toBe('SEARCH');
  });
});
