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

  test('BOT-03: ربات ادمین در بدو ورود با /start یا رمز اشتباه، دسترسی را مسدود نگه می‌دارد', async () => {
    const adminWorker = new TelegramBotWorker({
      token: 'mock_admin_token',
      role: 'ADMIN',
      adapter: telegramAdapter,
      adminAuthService: authService,
      inventoryService,
      reservationService,
      adminPasskey: 'admin110',
    });

    expect(adminWorker.getAuthenticatedAdmins()).toEqual([]);

    // ارسال رمز اشتباه
    await (adminWorker as any).handleUpdate({
      update_id: 9001,
      message: { message_id: 1, chat: { id: 55501 }, text: 'wrong_secret' },
    });

    expect(adminWorker.getAuthenticatedAdmins()).not.toContain('55501');
  });

  test('BOT-04: ورود با رمز admin110 کاربر را احراز هویت کرده و به لیست ادمین‌ها می‌افزاید', async () => {
    const adminWorker = new TelegramBotWorker({
      token: 'mock_admin_token',
      role: 'ADMIN',
      adapter: telegramAdapter,
      adminAuthService: authService,
      inventoryService,
      reservationService,
      adminPasskey: 'admin110',
    });

    // ورود رمز صحیح
    await (adminWorker as any).handleUpdate({
      update_id: 9002,
      message: { message_id: 2, chat: { id: 55501 }, from: { id: 55501 }, text: 'admin110' },
    });

    expect(adminWorker.getAuthenticatedAdmins()).toContain('55501');

    // خروج با /logout
    await (adminWorker as any).handleUpdate({
      update_id: 9003,
      message: { message_id: 3, chat: { id: 55501 }, text: '/logout' },
    });

    expect(adminWorker.getAuthenticatedAdmins()).not.toContain('55501');
  });

  test('BOT-05: گزارش آماری برای ادمین احراز هویت‌شده وضعیت موکب‌ها و سرور را بازمی‌گرداند', async () => {
    const adminWorker = new TelegramBotWorker({
      token: 'mock_admin_token',
      role: 'ADMIN',
      adapter: telegramAdapter,
      adminAuthService: authService,
      inventoryService,
      reservationService,
      adminPasskey: 'admin110',
    });

    adminWorker.addAuthenticatedAdmin('55501');

    // درخواست گزارش
    await expect(
      (adminWorker as any).handleUpdate({
        update_id: 9004,
        callback_query: { id: 'cb1', from: { id: 55501 }, message: { chat: { id: 55501 }, message_id: 4 }, data: 'ADMIN_STATS' },
      })
    ).resolves.toBeUndefined();
  });

  test('BOT-06: ارسال اعلان و برودکست از بات موکب‌دار به تمام ادمین‌های احراز هویت‌شده', async () => {
    const adminWorker = new TelegramBotWorker({
      token: 'mock_admin_token',
      role: 'ADMIN',
      adapter: telegramAdapter,
      adminAuthService: authService,
      inventoryService,
      reservationService,
      adminPasskey: 'admin110',
    });

    const hostWorker = new TelegramBotWorker({
      token: 'mock_host_token',
      role: 'HOST',
      adapter: telegramAdapter,
      inventoryService,
    });

    hostWorker.setPeerAdminWorker(adminWorker);
    adminWorker.addAuthenticatedAdmin('admin-chat-99');

    // ارسال اعلان برودکست
    await expect(adminWorker.broadcastToAdmins('📢 تست اعلان سامانه')).resolves.toBeUndefined();
  });

  test('BOT-07: تأیید موکب در کارتابل تلگرام وضعیت موکب را از PENDING به APPROVED تغییر می‌دهد', async () => {
    const adminWorker = new TelegramBotWorker({
      token: 'mock_admin_token',
      role: 'ADMIN',
      adapter: telegramAdapter,
      adminAuthService: authService,
      inventoryService,
      reservationService,
      adminPasskey: 'admin110',
    });

    adminWorker.addAuthenticatedAdmin('admin-chat-99');

    // ثبت موکب PENDING
    const mokab = await inventoryService.registerMokabPlace({
      hostPersonId: 'host-99',
      title: 'موکب شهدای مدافع حرم',
      city: 'نجف',
      address: 'ثوره العشرین',
      contactName: 'حاج علی',
      contactPhone: '09123333333',
      placePhotoPath: '/photos/p.jpg',
      responsibilityDocumentPath: '/docs/r.pdf',
      supplyType: 'PUBLIC',
      financialModel: 'FREE',
      approvalMode: 'INSTANT',
    });

    expect(mokab.status).toBe('PENDING');

    // کلیک دکمه تأیید توسط ادمین در تلگرام
    await (adminWorker as any).handleUpdate({
      update_id: 9005,
      callback_query: {
        id: 'cb2',
        from: { id: 99 },
        message: { chat: { id: 'admin-chat-99' }, message_id: 5 },
        data: `APPROVE_PLACE_${mokab.id}`,
      },
    });

    const updated = await inventoryService.getPlaceById(mokab.id);
    expect(updated?.status).toBe('APPROVED');
  });

  test('BOT-08: پاکسازی خودکار پیام تایپی کاربر (deleteMessage) پس از دریافت و پردازش (DEC-0048)', async () => {
    const travelerWorker = new TelegramBotWorker({
      token: 'mock_traveler_token',
      role: 'TRAVELER',
      adapter: telegramAdapter,
      inventoryService,
    });

    let deleteCalled = false;
    (travelerWorker as any).deleteMessage = async (chatId: string, messageId: number | string) => {
      deleteCalled = true;
      return true;
    };

    // کاربر یک پیام تایپ می‌کند
    await (travelerWorker as any).handleUpdate({
      update_id: 9010,
      message: { message_id: 7788, chat: { id: 12345 }, text: '/start' },
    });

    expect(deleteCalled).toBe(true);
  });

  test('BOT-09: ویرایش درجا پیام روی همان message_id در کلیک‌های شیشه‌ای بدون ارسال پیام تکراری (DEC-0048)', async () => {
    const travelerWorker = new TelegramBotWorker({
      token: 'mock_traveler_token',
      role: 'TRAVELER',
      adapter: telegramAdapter,
      inventoryService,
    });

    let editedMessageId: number | string | undefined;
    (travelerWorker as any).editMessageText = async (params: any) => {
      editedMessageId = params.messageId;
      return true;
    };

    // کاربر روی دکمه شیشه‌ای کلیک می‌کند
    await (travelerWorker as any).handleUpdate({
      update_id: 9011,
      callback_query: {
        id: 'cb_search',
        message: { chat: { id: 12345 }, message_id: 9988 },
        data: 'SEARCH_SPACES',
      },
    });

    // باید دقیقا همان پیام قبلی ویرایش شود
    expect(editedMessageId).toBe(9988);
  });

  test('WIZ-01: ویزارد مرحله‌ای ثبت موکب در ربات موکب‌داران از انتخاب شهر تا ثبت قطعی (DEC-0049)', async () => {
    const hostWorker = new TelegramBotWorker({
      token: 'mock_host_token',
      role: 'HOST',
      adapter: telegramAdapter,
      inventoryService,
    });

    const adminWorker = new TelegramBotWorker({
      token: 'mock_admin_token',
      role: 'ADMIN',
      adapter: telegramAdapter,
      inventoryService,
    });
    adminWorker.addAuthenticatedAdmin('admin-chat-1');
    hostWorker.setPeerAdminWorker(adminWorker);

    let lastSentText = '';
    (hostWorker as any).editOrSendMessage = async (params: any) => {
      lastSentText = params.text;
    };

    const hostChatId = 'host-chat-100';

    // گام ۱: کلیک ثبت موکب
    await (hostWorker as any).handleUpdate({
      update_id: 10001,
      callback_query: {
        id: 'cb_reg',
        from: { id: 100 },
        message: { chat: { id: hostChatId }, message_id: 1 },
        data: 'REGISTER_HOST',
      },
    });
    expect(lastSentText).toContain('گام ۱ از ۷');

    // گام ۱ انتخاب شهر
    await (hostWorker as any).handleUpdate({
      update_id: 10002,
      callback_query: {
        id: 'cb_city',
        from: { id: 100 },
        message: { chat: { id: hostChatId }, message_id: 1 },
        data: 'HOST_CITY_کربلای معلی',
      },
    });
    expect(lastSentText).toContain('گام ۲ از ۷');

    // گام ۲ ارسال نام موکب به صورت تکست
    await (hostWorker as any).handleUpdate({
      update_id: 10003,
      message: { message_id: 2, chat: { id: hostChatId }, from: { id: 100 }, text: 'موکب انصار الحسین علیه‌السلام' },
    });
    expect(lastSentText).toContain('گام ۳ از ۷');

    // گام ۳ ارسال نام مسئول و شماره تماس
    await (hostWorker as any).handleUpdate({
      update_id: 10004,
      message: { message_id: 3, chat: { id: hostChatId }, from: { id: 100 }, text: 'حاج رضا کریمی 09129999999' },
    });
    expect(lastSentText).toContain('گام ۴ از ۷');

    // گام ۴ ارسال نشانی دقیق
    await (hostWorker as any).handleUpdate({
      update_id: 10005,
      message: { message_id: 4, chat: { id: hostChatId }, from: { id: 100 }, text: 'شارع میثم تمار، عمود ۳۰۰' },
    });
    expect(lastSentText).toContain('گام ۵ از ۷');

    // گام ۵ انتخاب سالن عمومی
    await (hostWorker as any).handleUpdate({
      update_id: 10006,
      callback_query: {
        id: 'cb_supply',
        from: { id: 100 },
        message: { chat: { id: hostChatId }, message_id: 1 },
        data: 'HOST_SUPPLY_PUBLIC',
      },
    });
    expect(lastSentText).toContain('تعیین ظرفیت سالن‌های عمومی');

    // گام تعیین ظرفیت: ۱۰۰ نفر
    await (hostWorker as any).handleUpdate({
      update_id: 10007,
      callback_query: {
        id: 'cb_cap',
        from: { id: 100 },
        message: { chat: { id: hostChatId }, message_id: 1 },
        data: 'HOST_CAP_100',
      },
    });
    expect(lastSentText).toContain('گام ۶ از ۷');

    // گام ۶ انتخاب مدل رایگان
    await (hostWorker as any).handleUpdate({
      update_id: 10008,
      callback_query: {
        id: 'cb_fin',
        from: { id: 100 },
        message: { chat: { id: hostChatId }, message_id: 1 },
        data: 'HOST_FIN_FREE',
      },
    });
    expect(lastSentText).toContain('گام ۷ از ۷');

    // گام ۷ انتخاب تأیید فوری
    await (hostWorker as any).handleUpdate({
      update_id: 10009,
      callback_query: {
        id: 'cb_app',
        from: { id: 100 },
        message: { chat: { id: hostChatId }, message_id: 1 },
        data: 'HOST_APP_INSTANT',
      },
    });
    expect(lastSentText).toContain('پیش‌نمایش پرونده موکب');

    // ثبت نهایی و قطعی
    await (hostWorker as any).handleUpdate({
      update_id: 10010,
      callback_query: {
        id: 'cb_submit',
        from: { id: 100 },
        message: { chat: { id: hostChatId }, message_id: 1 },
        data: 'HOST_SUBMIT_PLACE',
      },
    });
    expect(lastSentText).toContain('موکب شما با موفقیت ثبت گردید');

    // راستی‌آزمایی در دیتابیس InventoryService
    const allPlaces = await inventoryService.getAllPlaces();
    const registered = allPlaces.find(p => p.title === 'موکب انصار الحسین علیه‌السلام');
    expect(registered).toBeDefined();
    expect(registered?.status).toBe('PENDING');
    expect(registered?.city).toBe('کربلای معلی');

    // بررسی سالن‌ها
    const spaces = await inventoryService.getSpacesByPlaceId(registered!.id);
    expect(spaces.length).toBe(2); // سالن برادران و خواهران
    expect(spaces.reduce((s, x) => s + x.nominalCapacity, 0)).toBe(100);
  });

  test('WIZ-02: بررسی کارتابل وضعیت سالن‌ها و اتاق‌ها (ROOMS_STATUS) برای موکب‌دار (DEC-0049)', async () => {
    // ثبت موکب تستی برای موکب‌دار با شناسه ۱۰۰
    const testPlace = await inventoryService.registerMokabPlace({
      hostPersonId: '100',
      title: 'موکب انصار الحسین علیه‌السلام',
      city: 'کربلای معلی',
      address: 'شارع میثم تمار، عمود ۳۰۰',
      contactName: 'حاج رضا کریمی',
      contactPhone: '09129999999',
      placePhotoPath: 'default_place.jpg',
      responsibilityDocumentPath: 'default_doc.pdf',
      supplyType: 'PUBLIC',
      financialModel: 'FREE',
      approvalMode: 'INSTANT',
    });
    await inventoryService.registerPublicHall(testPlace.id, 'سالن عمومی برادران', 'MEN', 50);
    await inventoryService.registerPublicHall(testPlace.id, 'سالن عمومی خواهران', 'WOMEN', 50);

    const hostWorker = new TelegramBotWorker({
      token: 'mock_host_token',
      role: 'HOST',
      adapter: telegramAdapter,
      inventoryService,
    });

    let statusReportText = '';
    (hostWorker as any).editOrSendMessage = async (params: any) => {
      statusReportText = params.text;
    };

    // کاربر درخواست کارتابل موکب‌های خود را می‌دهد
    await (hostWorker as any).handleUpdate({
      update_id: 10020,
      callback_query: {
        id: 'cb_rooms',
        from: { id: 100 },
        message: { chat: { id: 'host-chat-100' }, message_id: 1 },
        data: 'ROOMS_STATUS',
      },
    });

    expect(statusReportText).toContain('موکب انصار الحسین علیه‌السلام');
    expect(statusReportText).toContain('در صف بررسی ادمین');
  });

  test('WIZ-03: تأیید موکب توسط ادمین و سپس جست‌وجو و رزرو زائر در تلگرام (DEC-0049)', async () => {
    // ثبت موکب در صف بررسی
    const targetPlace = await inventoryService.registerMokabPlace({
      hostPersonId: '100',
      title: 'موکب انصار الحسین علیه‌السلام',
      city: 'کربلای معلی',
      address: 'شارع میثم تمار، عمود ۳۰۰',
      contactName: 'حاج رضا کریمی',
      contactPhone: '09129999999',
      placePhotoPath: 'default_place.jpg',
      responsibilityDocumentPath: 'default_doc.pdf',
      supplyType: 'PUBLIC',
      financialModel: 'FREE',
      approvalMode: 'INSTANT',
    });
    await inventoryService.registerPublicHall(targetPlace.id, 'سالن برادران', 'MEN', 50);

    const adminWorker = new TelegramBotWorker({
      token: 'mock_admin_token',
      role: 'ADMIN',
      adapter: telegramAdapter,
      inventoryService,
    });
    adminWorker.addAuthenticatedAdmin('admin-chat-1');

    // ۱. ادمین موکب را تأیید می‌کند
    await (adminWorker as any).handleUpdate({
      update_id: 10030,
      callback_query: {
        id: 'cb_approve',
        from: { id: 1 },
        message: { chat: { id: 'admin-chat-1' }, message_id: 10 },
        data: `APPROVE_PLACE_${targetPlace.id}`,
      },
    });

    const approvedPlace = await inventoryService.getPlaceById(targetPlace.id);
    expect(approvedPlace?.status).toBe('APPROVED');

    // ۲. زائر در بات مسافران جست‌وجوی کربلا را می‌زند
    const travelerWorker = new TelegramBotWorker({
      token: 'mock_traveler_token',
      role: 'TRAVELER',
      adapter: telegramAdapter,
      inventoryService,
    });

    let travelerReply = '';
    (travelerWorker as any).editOrSendMessage = async (params: any) => {
      travelerReply = params.text;
    };

    await (travelerWorker as any).handleUpdate({
      update_id: 10031,
      callback_query: {
        id: 'cb_search_karbala',
        from: { id: 777 },
        message: { chat: { id: 'traveler-777' }, message_id: 20 },
        data: 'TRAVELER_CITY_کربلای معلی',
      },
    });

    // باید موکب تأییدشده در نتایج بیاید
    expect(travelerReply).toContain('موکب انصار الحسین علیه‌السلام');

    // ۳. زائر درخواست رزرو ثبت می‌کند
    await (travelerWorker as any).handleUpdate({
      update_id: 10032,
      callback_query: {
        id: 'cb_dobook',
        from: { id: 777 },
        message: { chat: { id: 'traveler-777' }, message_id: 20 },
        data: `TRAVELER_DOBOOK_${targetPlace.id}_2`,
      },
    });

    expect(travelerReply).toContain('درخواست اسکان شما با موفقیت ثبت شد');
    expect(travelerReply).toContain('کد رهگیری رزرو');

    // ۴. زائر پیگیری رزروهای من را می‌زند
    await (travelerWorker as any).handleUpdate({
      update_id: 10033,
      callback_query: {
        id: 'cb_my_res',
        from: { id: 777 },
        message: { chat: { id: 'traveler-777' }, message_id: 20 },
        data: 'MY_RESERVATIONS',
      },
    });

    expect(travelerReply).toContain('لیست رزروهای شما');
    expect(travelerReply).toContain('موکب انصار الحسین علیه‌السلام');
  });

  // ----------------------------------------------------
  // ۴. آزمون‌های انعطاف‌پذیری و ورودی دوگانه متنی/دکمه‌ای (MASTER-31 / DEC-0050)
  // ----------------------------------------------------
  test('FLEX-01: شروع ثبت موکب با متن و مهار شهرهای ممنوعه عربستان (DEC-0002, DEC-0050)', async () => {
    const hostWorker = new TelegramBotWorker({
      token: 'mock_host_flex',
      role: 'HOST',
      adapter: telegramAdapter,
      inventoryService,
    });

    let botResponse = '';
    (hostWorker as any).editOrSendMessage = async (params: any) => {
      botResponse = params.text;
    };

    const hostChatId = 'host-chat-flex-1';

    // ۱. ارسال پیام متنی "ثبت موکب" به جای کلیک دکمه
    await (hostWorker as any).handleUpdate({
      update_id: 20001,
      message: {
        message_id: 1,
        chat: { id: hostChatId },
        from: { id: 101 },
        text: 'سلام خسته نباشید، می‌خواهم ثبت موکب انجام دهم',
      },
    });
    expect(botResponse).toContain('گام ۱ از ۷');

    // ۲. ارسال نام شهر ممنوعه عربستان (مکه مکرمه) -> باید رد شود (DEC-0002)
    await (hostWorker as any).handleUpdate({
      update_id: 20002,
      message: {
        message_id: 2,
        chat: { id: hostChatId },
        from: { id: 101 },
        text: 'مکه مکرمه',
      },
    });
    expect(botResponse).toContain('محدودیت سامانه (DEC-0002)');
    expect(botResponse).toContain('عربستان');

    // ۳. ارسال نام شهر زیارتی دلخواه (سامرا) -> باید پذیرفته شده و به گام ۲ برود
    await (hostWorker as any).handleUpdate({
      update_id: 20003,
      message: {
        message_id: 3,
        chat: { id: hostChatId },
        from: { id: 101 },
        text: 'سامرا',
      },
    });
    expect(botResponse).toContain('گام ۲ از ۷');
    expect(botResponse).toContain('سامرا');
  });

  test('FLEX-02: تعیین ظرفیت سالن‌های عمومی با رقم دلخواه تایپی (۱۵۰ نفر) (DEC-0050)', async () => {
    const hostWorker = new TelegramBotWorker({
      token: 'mock_host_flex',
      role: 'HOST',
      adapter: telegramAdapter,
      inventoryService,
    });

    let botResponse = '';
    (hostWorker as any).editOrSendMessage = async (params: any) => {
      botResponse = params.text;
    };

    const hostChatId = 'host-chat-flex-2';

    // شروع ویزارد و ثبت گام‌های اولیه
    await (hostWorker as any).handleUpdate({
      update_id: 20010,
      callback_query: { id: 'cb1', from: { id: 102 }, message: { chat: { id: hostChatId }, message_id: 1 }, data: 'REGISTER_HOST' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20011,
      callback_query: { id: 'cb2', from: { id: 102 }, message: { chat: { id: hostChatId }, message_id: 1 }, data: 'HOST_CITY_نجف اشرف' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20012,
      message: { message_id: 2, chat: { id: hostChatId }, from: { id: 102 }, text: 'موکب امیرالمؤمنین' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20013,
      message: { message_id: 3, chat: { id: hostChatId }, from: { id: 102 }, text: 'علی حسینی 09123333333' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20014,
      message: { message_id: 4, chat: { id: hostChatId }, from: { id: 102 }, text: 'میدان ثورة العشرین' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20015,
      callback_query: { id: 'cb3', from: { id: 102 }, message: { chat: { id: hostChatId }, message_id: 1 }, data: 'HOST_SUPPLY_PUBLIC' },
    });
    expect(botResponse).toContain('تعیین ظرفیت سالن‌های عمومی');

    // تایپ رقم دلخواه با ارقام فارسی و پسوند نفر
    await (hostWorker as any).handleUpdate({
      update_id: 20016,
      message: { message_id: 5, chat: { id: hostChatId }, from: { id: 102 }, text: '۱۵۰ نفر' },
    });
    expect(botResponse).toContain('گام ۶ از ۷ - مدل مالی');

    const wiz = (hostWorker as any).hostWizards.get(hostChatId);
    expect(wiz.data.hallCapacity).toBe(150);
  });

  test('FLEX-03: تعیین تعداد و ظرفیت اتاق‌های دربست با عبارت ترکیبی (۳ اتاق ۵ نفره) (DEC-0050)', async () => {
    const hostWorker = new TelegramBotWorker({
      token: 'mock_host_flex',
      role: 'HOST',
      adapter: telegramAdapter,
      inventoryService,
    });

    let botResponse = '';
    (hostWorker as any).editOrSendMessage = async (params: any) => {
      botResponse = params.text;
    };

    const hostChatId = 'host-chat-flex-3';

    await (hostWorker as any).handleUpdate({
      update_id: 20020,
      callback_query: { id: 'cb1', from: { id: 103 }, message: { chat: { id: hostChatId }, message_id: 1 }, data: 'REGISTER_HOST' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20021,
      callback_query: { id: 'cb2', from: { id: 103 }, message: { chat: { id: hostChatId }, message_id: 1 }, data: 'HOST_CITY_مشهد مقدس' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20022,
      message: { message_id: 2, chat: { id: hostChatId }, from: { id: 103 }, text: 'حسینیه امام رضا' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20023,
      message: { message_id: 3, chat: { id: hostChatId }, from: { id: 103 }, text: 'رضا مشهدی 09151111111' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20024,
      message: { message_id: 4, chat: { id: hostChatId }, from: { id: 103 }, text: 'خیابان طبرسی' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20025,
      callback_query: { id: 'cb3', from: { id: 103 }, message: { chat: { id: hostChatId }, message_id: 1 }, data: 'HOST_SUPPLY_PRIVATE' },
    });

    // تایپ عبارت ترکیبی اتاق‌ها: "۳ اتاق ۵ نفره"
    await (hostWorker as any).handleUpdate({
      update_id: 20026,
      message: { message_id: 5, chat: { id: hostChatId }, from: { id: 103 }, text: '۳ اتاق ۵ نفره' },
    });
    expect(botResponse).toContain('گام ۶ از ۷ - مدل مالی');

    const wiz = (hostWorker as any).hostWizards.get(hostChatId);
    expect(wiz.data.roomCount).toBe(3);
    expect(wiz.data.roomCapacity).toBe(5);
  });

  test('FLEX-04: تعیین مبلغ سفارشی هزینه اقامت و ثبت نهایی موکب (DEC-0050)', async () => {
    const hostWorker = new TelegramBotWorker({
      token: 'mock_host_flex',
      role: 'HOST',
      adapter: telegramAdapter,
      inventoryService,
    });

    let botResponse = '';
    (hostWorker as any).editOrSendMessage = async (params: any) => {
      botResponse = params.text;
    };

    const hostChatId = 'host-chat-flex-4';

    // طی گام‌ها تا گام مدل مالی
    await (hostWorker as any).handleUpdate({
      update_id: 20030,
      callback_query: { id: 'cb1', from: { id: 104 }, message: { chat: { id: hostChatId }, message_id: 1 }, data: 'REGISTER_HOST' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20031,
      callback_query: { id: 'cb2', from: { id: 104 }, message: { chat: { id: hostChatId }, message_id: 1 }, data: 'HOST_CITY_قم مقدسه' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20032,
      message: { message_id: 2, chat: { id: hostChatId }, from: { id: 104 }, text: 'زائرسرای حضرت معصومه' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20033,
      message: { message_id: 3, chat: { id: hostChatId }, from: { id: 104 }, text: 'مهدی قمی 09125555555' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20034,
      message: { message_id: 4, chat: { id: hostChatId }, from: { id: 104 }, text: 'چهارمردان' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20035,
      callback_query: { id: 'cb3', from: { id: 104 }, message: { chat: { id: hostChatId }, message_id: 1 }, data: 'HOST_SUPPLY_PUBLIC' },
    });
    await (hostWorker as any).handleUpdate({
      update_id: 20036,
      callback_query: { id: 'cb4', from: { id: 104 }, message: { chat: { id: hostChatId }, message_id: 1 }, data: 'HOST_CAP_50' },
    });
    expect(botResponse).toContain('گام ۶ از ۷ - مدل مالی');

    // کلیک روی تعیین هزینه دلخواه و سپس تایپ ۷۰ هزار تومان
    await (hostWorker as any).handleUpdate({
      update_id: 20037,
      callback_query: { id: 'cb5', from: { id: 104 }, message: { chat: { id: hostChatId }, message_id: 1 }, data: 'HOST_FIN_CHOOSE_FEE' },
    });
    expect(botResponse).toContain('تعیین مبلغ هزینه اقامت');

    // تایپ ۷۰,۰۰۰ تومان
    await (hostWorker as any).handleUpdate({
      update_id: 20038,
      message: { message_id: 6, chat: { id: hostChatId }, from: { id: 104 }, text: '۷۰ هزار تومان' },
    });
    expect(botResponse).toContain('گام ۷ از ۷ - شیوه تأیید');

    // انتخاب تأیید فوری
    await (hostWorker as any).handleUpdate({
      update_id: 20039,
      callback_query: { id: 'cb6', from: { id: 104 }, message: { chat: { id: hostChatId }, message_id: 1 }, data: 'HOST_APP_INSTANT' },
    });
    expect(botResponse).toContain('پیش‌نمایش پرونده موکب');
    expect(botResponse).toContain('۷۰٬۰۰۰');

    // تایید و ثبت نهایی با ارسال پیام متنی "تایید"
    await (hostWorker as any).handleUpdate({
      update_id: 20040,
      message: { message_id: 7, chat: { id: hostChatId }, from: { id: 104 }, text: 'تایید' },
    });
    expect(botResponse).toContain('موکب شما با موفقیت ثبت گردید');

    // راستی‌آزمایی در دیتابیس
    const places = await inventoryService.getAllPlaces();
    const qomPlace = places.find(p => p.title === 'زائرسرای حضرت معصومه');
    expect(qomPlace).toBeDefined();
    expect(qomPlace?.financialModel).toBe('FIXED_FEE');
    expect(qomPlace?.feeAmountToman).toBe(70000);
  });

  test('FLEX-05: ورودی دوگانه زائر با ارسال پیام متنی برای جست‌وجو و پیگیری (DEC-0050)', async () => {
    const travelerWorker = new TelegramBotWorker({
      token: 'mock_traveler_flex',
      role: 'TRAVELER',
      adapter: telegramAdapter,
      inventoryService,
    });

    let travelerReply = '';
    (travelerWorker as any).editOrSendMessage = async (params: any) => {
      travelerReply = params.text;
    };

    // زائر پیام متنی "کربلا" ارسال می‌کند
    await (travelerWorker as any).handleUpdate({
      update_id: 20050,
      message: {
        message_id: 1,
        chat: { id: 'traveler-flex-1' },
        from: { id: 999 },
        text: 'سلام، موکب‌های کربلا را می‌خواهم ببینم',
      },
    });
    expect(travelerReply).toContain('نتایج جست‌وجو در کربلای معلی');

    // زائر پیام متنی "پیگیری رزروهای من" ارسال می‌کند
    await (travelerWorker as any).handleUpdate({
      update_id: 20051,
      message: {
        message_id: 2,
        chat: { id: 'traveler-flex-1' },
        from: { id: 999 },
        text: 'پیگیری رزروهای من',
      },
    });
    expect(travelerReply).toContain('پیگیری رزروها');
  });
});

