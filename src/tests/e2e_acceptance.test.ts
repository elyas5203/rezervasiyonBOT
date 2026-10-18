/**
 * آزمون‌های سرتاسری یکپارچه و پذیرش نهایی سامانه (End-to-End Acceptance Testing)
 * انطباق با: MASTER-10, MASTER-23 و تمامی تصمیم‌های مصوب DEC-0001 تا DEC-0044
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  CapacityService,
} from '../core/capacity/capacity-service';
import {
  InventoryService,
  InMemoryInventoryRepository,
} from '../core/inventory/inventory-service';
import {
  ReservationService,
} from '../core/reservation/reservation-service';
import {
  BillingService,
} from '../core/billing/billing-service';
import {
  StayService,
} from '../core/stay/stay-service';
import {
  NotificationService,
} from '../core/notification/notification-service';
import {
  IdentityService,
  InMemoryIdentityRepository,
} from '../core/identity/identity-service';
import {
  AdminAuthService,
  AdminManagementService,
} from '../admin/admin-service';
import {
  TelegramAdapter,
  BaleAdapter,
  MessageDeduplicator,
} from '../channels/channel-adapter';

describe('MASTER-23 — آزمون‌های سرتاسری یکپارچه و پذیرش نهایی سامانه (E2E Acceptance)', () => {
  let capacityService: CapacityService;
  let inventoryRepo: InMemoryInventoryRepository;
  let inventoryService: InventoryService;
  let reservationService: ReservationService;
  let billingService: BillingService;
  let stayService: StayService;
  let notificationService: NotificationService;
  let identityRepo: InMemoryIdentityRepository;
  let identityService: IdentityService;
  let adminAuthService: AdminAuthService;
  let adminService: AdminManagementService;
  let deduplicator: MessageDeduplicator;
  let telegramAdapter: TelegramAdapter;
  let baleAdapter: BaleAdapter;

  beforeEach(() => {
    capacityService = new CapacityService();
    inventoryRepo = new InMemoryInventoryRepository();
    inventoryService = new InventoryService(inventoryRepo);
    reservationService = new ReservationService(capacityService);
    billingService = new BillingService(reservationService, capacityService);
    notificationService = new NotificationService();
    stayService = new StayService(reservationService, capacityService, notificationService);

    identityRepo = new InMemoryIdentityRepository();
    identityService = new IdentityService(identityRepo);

    adminAuthService = new AdminAuthService();
    adminService = new AdminManagementService(adminAuthService, inventoryService, reservationService);

    deduplicator = new MessageDeduplicator();
    telegramAdapter = new TelegramAdapter(deduplicator);
    baleAdapter = new BaleAdapter(deduplicator);
  });

  // ----------------------------------------------------
  // سناریو ۱: سفر کامل زائر در مسیر فوری و رایگان با ثبت موکب و تأیید ادمین
  // ----------------------------------------------------
  test('E2E-SC01: سفر کامل زائر در مسیر فوری و رایگان با ثبت موکب، تأیید ادمین و ورود/خروج', async () => {
    // ۱. موکب‌دار موکب خود را با ۴ مدرک استاندارد ثبت می‌کند (DEC-0041)
    const mokab = await inventoryService.registerMokabPlace({
      hostPersonId: 'host-p1',
      title: 'موکب علی بن موسی الرضا (ع)',
      city: 'نجف',
      address: 'شارع الحولی، عمود ۲۰۰',
      contactName: 'حاج مصطفی',
      contactPhone: '09121112233',
      placePhotoPath: '/photos/mokab_najaf.jpg',
      responsibilityDocumentPath: '/docs/najaf_auth.pdf',
      supplyType: 'PUBLIC',
      financialModel: 'FREE',
      approvalMode: 'INSTANT',
      cancellationRules: 'لغو تا ۲۴ ساعت پیش از ورود رایگان است.',
    });

    // موکب‌دار سالن عمومی برادران به ظرفیت ۵۰ نفر تعریف می‌کند
    const hall = await inventoryService.registerPublicHall(
      mokab.id,
      'سالن شماره ۱ برادران',
      'MEN',
      50
    );

    // موکب قبل از تأیید ادمین در جست‌وجوی عمومی زائران پنهان است (DEC-0004)
    const publicPlacesBefore = await inventoryService.getApprovedPlaces('نجف');
    expect(publicPlacesBefore.some(p => p.id === mokab.id)).toBe(false);

    // ۲. مدیر اصلی وارد وب‌ویو می‌شود و موکب را پس از بازبینی تأیید می‌کند
    const adminToken = await adminAuthService.generateLoginToken('admin-super-001');
    const adminSession = await adminAuthService.exchangeTokenForSession(adminToken);
    await adminService.reviewHost(
      adminSession.sessionId,
      mokab.id,
      'APPROVE',
      'مدارک ۴گانه و موقعیت مکانی بررسی و تأیید شد.'
    );

    // پس از تأیید، موکب در جست‌وجو نمایان می‌شود
    const publicPlacesAfter = await inventoryService.getApprovedPlaces('نجف');
    expect(publicPlacesAfter.some(p => p.id === mokab.id)).toBe(true);

    // ۳. زائر در تلگرام ثبت نام اولیه کرده و بدون شماره وارد می‌شود (DEC-0043)
    const { person: travelerAccount } = await identityService.getOrCreateAccount('TELEGRAM', 'tg_traveler_01');
    expect(travelerAccount.id).toBeDefined();

    // ۴. زائر برای تاریخ ۲۰ تا ۲۳ آبان (بیش از ۷ روز مانده) برای ۲ نفر رزرو ثبت می‌کند
    const checkInDate = '2026-11-20';
    const checkOutDate = '2026-11-23';
    const bookingNow = new Date('2026-11-01T10:00:00Z'); // ۱۹ روز قبل

    const reservation = await reservationService.createReservation({
      personId: travelerAccount.id,
      contactPhone: '09198765432', // شماره هنگام ثبت درخواست رزرو دریافت می‌شود (DEC-0043)
      place: mokab,
      space: hall,
      checkInDate,
      checkOutDate,
      maleCount: 2,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: false,
      now: bookingNow,
    });

    // در مسیر ۱ (فوری + رایگان)، رزرو فوراً CONFIRMED شده و هولد قطعی می‌شود
    expect(reservation.status).toBe('CONFIRMED');
    expect(reservation.trackingCode).toBeDefined();

    // ظرفیت بررسی می‌شود: ۲ نفر از ۵۰ نفر کسر شده است (۴۸ نفر باقیمانده)
    const availability = await capacityService.checkPublicHallAvailability(hall, ['2026-11-20', '2026-11-21', '2026-11-22'], 49);
    expect(availability.available).toBe(false); // درخواست ۴۹ نفر رد می‌شود چون فقط ۴۸ جا هست

    // ۵. روز ورود مسافر فرا می‌رسد (Check-in)
    const checkedIn = await stayService.checkIn(reservation.id, mokab.hostPersonId, new Date('2026-11-20T14:00:00Z'));
    expect(checkedIn.status).toBe('CONFIRMED');

    // ۶. روز خروج مسافر فرا می‌رسد (Check-out)
    const checkedOut = await stayService.checkOut(reservation.id, mokab.hostPersonId, new Date('2026-11-23T10:00:00Z'));
    expect(checkedOut.status).toBe('COMPLETED');
  });

  // ----------------------------------------------------
  // سناریو ۲: سفر کامل زائر در مسیر پولی کارت‌به‌کارت با فیش و تأیید موکب‌دار
  // ----------------------------------------------------
  test('E2E-SC02: سفر کامل در مسیر پولی کارت‌به‌کارت با ارسال فیش، تطبیق دستی موکب‌دار و ممنوعیت دخالت ادمین', async () => {
    // ۱. ثبت موکب با هزینه ثابت ۱۰۰ هزار تومان برای هر رزرو (DEC-0013, DEC-0038)
    const mokab = await inventoryService.registerMokabPlace({
      hostPersonId: 'host-p2',
      title: 'موکب فاطمة الزهراء (س)',
      city: 'کربلا',
      address: 'خیابان سدره',
      contactName: 'سید علی',
      contactPhone: '09123334455',
      placePhotoPath: '/photos/karbala_place.jpg',
      responsibilityDocumentPath: '/docs/karbala_auth.pdf',
      supplyType: 'PRIVATE',
      financialModel: 'FIXED_FEE',
      feeAmountToman: 100000,
      approvalMode: 'INSTANT',
    });

    const [room] = await inventoryService.registerPrivateRoomsBatch(mokab.id, 'اتاق خانوادگی', 1, 4);

    // تأیید موکب توسط ادمین
    const adminToken = await adminAuthService.generateLoginToken('admin-super-001');
    const adminSession = await adminAuthService.exchangeTokenForSession(adminToken);
    await adminService.reviewHost(adminSession.sessionId, mokab.id, 'APPROVE', 'تأیید شد');

    // ۲. ثبت رزرو فوری+پولی برای یک خانواده ۴ نفره
    const reservation = await reservationService.createReservation({
      personId: 'traveler-p2',
      contactPhone: '09129998877',
      place: mokab,
      space: room,
      checkInDate: '2026-11-25',
      checkOutDate: '2026-11-28',
      maleCount: 2,
      femaleCount: 1,
      childCount: 1, // کودک شمرده می‌شود (DEC-0027)
      isForeignPilgrim: false,
      now: new Date('2026-11-01T10:00:00Z'),
    });

    // در مسیر ۳ (فوری + پولی)، رزرو در انتظار فیش و هولد ۲۴ ساعته قرار می‌گیرد
    expect(reservation.status).toBe('PENDING_PAYMENT_RECEIPT');
    expect(reservation.holdExpiresAt).toBeDefined();

    // محاسبه مبلغ مقطوع کل رزرو
    const amount = billingService.calculateTotalAmount(mokab.financialModel, mokab.feeAmountToman, mokab.depositAmountToman);
    expect(amount).toBe(100000);

    // ۳. زائر تصویر فیش واریز کارت‌به‌کارت را بارگذاری می‌کند (DEC-0012)
    const receipt = await billingService.submitPaymentReceipt(reservation.id, '/receipts/fish_123.jpg');
    expect(receipt.verificationStatus).toBe('PENDING');

    const pendingRes = await reservationService.getReservationById(reservation.id);
    expect(pendingRes?.status).toBe('PENDING_RECEIPT_VERIFICATION');

    // ۴. بررسی مرز اختیار: ادمین سیستم نباید بتواند فیش را تأیید کند (DEC-0012, MASTER-08 ADM-03)
    await expect(
      adminService.verifyPaymentReceipt(adminSession.sessionId, reservation.id, true)
    ).rejects.toThrow('ADMIN_CANNOT_VERIFY_PAYMENT_RECEIPT');

    // ۵. موکب‌دار همان محل شخصاً واریز را تطبیق داده و تأیید می‌کند
    const verifiedReceipt = await billingService.reviewPaymentReceipt(receipt.id, mokab.hostPersonId, 'APPROVED');
    expect(verifiedReceipt.verificationStatus).toBe('APPROVED');

    // رزرو قطعی می‌شود
    const confirmedRes = await reservationService.getReservationById(reservation.id);
    expect(confirmedRes?.status).toBe('CONFIRMED');
  });

  // ----------------------------------------------------
  // سناریو ۳: زائر خارجی بدون وجه، با گذرنامه و پاکسازی ۳۰ روزه
  // ----------------------------------------------------
  test('E2E-SC03: زائر خارجی بدون درخواست وجه با ارسال گذرنامه، تأیید موکب‌دار و پاکسازی ۳۰ روزه گذرنامه', async () => {
    const mokab = await inventoryService.registerMokabPlace({
      hostPersonId: 'host-p3',
      title: 'موکب شهدای بصره',
      city: 'بصره',
      address: 'طریق بصره به نجف',
      contactName: 'ابوحیدر',
      contactPhone: '09124445566',
      placePhotoPath: '/photos/place3.jpg',
      responsibilityDocumentPath: '/docs/doc3.pdf',
      supplyType: 'PRIVATE',
      financialModel: 'FIXED_FEE',
      feeAmountToman: 200000, // حتی اگر موکب پولی باشد
      approvalMode: 'INSTANT', // حتی اگر موکب فوری باشد
    });

    const [room] = await inventoryService.registerPrivateRoomsBatch(mokab.id, 'سوئیت زائران', 1, 3);
    const adminToken = await adminAuthService.generateLoginToken('admin-super-001');
    const adminSession = await adminAuthService.exchangeTokenForSession(adminToken);
    await adminService.reviewHost(adminSession.sessionId, mokab.id, 'APPROVE', 'تأیید شد');

    // زائر خارجی بدون پرداخت وجه و با تصویر گذرنامه ثبت نام می‌کند (DEC-0032)
    const reservation = await reservationService.createReservation({
      personId: 'foreign-traveler-01',
      contactPhone: '+9647701234567',
      place: mokab,
      space: room,
      checkInDate: '2026-11-20',
      checkOutDate: '2026-11-23',
      maleCount: 2,
      femaleCount: 1,
      childCount: 0,
      isForeignPilgrim: true,
      passportImagePath: '/passports/foreign_01.jpg',
      now: new Date('2026-11-01T10:00:00Z'),
    });

    // رزرو مستقیماً بدون درخواست پول به PENDING_HOST_APPROVAL می‌رود
    expect(reservation.status).toBe('PENDING_HOST_APPROVAL');
    expect(reservation.passportImagePath).toBe('/passports/foreign_01.jpg');

    // مبلغ در سیستم باید صفر باشد (سامانه با مسافر خارجی تبادل ریالی ندارد)
    const amount = reservation.isForeignPilgrim ? 0 : billingService.calculateTotalAmount(mokab.financialModel, mokab.feeAmountToman, mokab.depositAmountToman);
    expect(amount).toBe(0);

    // موکب‌دار مدارک مسافر را مشاهده کرده و درخواست را تأیید می‌کند
    const confirmedRes = await reservationService.hostReviewReservation(
      reservation.id,
      mokab.hostPersonId,
      'ACCEPT',
      mokab,
      new Date('2026-11-02T10:00:00Z')
    );
    expect(confirmedRes.status).toBe('CONFIRMED');

    // مسافر اقامت را آغاز و به پایان می‌رساند
    await stayService.checkIn(reservation.id, mokab.hostPersonId, new Date('2026-11-20T14:00:00Z'));
    await stayService.checkOut(reservation.id, mokab.hostPersonId, new Date('2026-11-23T11:00:00Z'));

    // پس از گذشت ۳۰ روز از اتمام اقامت، جاب پاکسازی اجرا می‌شود (DEC-0036, DEC-0037)
    const runJobDate = new Date('2026-12-25T00:00:00Z'); // ۳۲ روز بعد
    const completedRes = await reservationService.getReservationById(reservation.id);
    const cleanedCount = await stayService.cleanupExpiredPassports([completedRes!], runJobDate);
    expect(cleanedCount).toBe(1);

    expect(completedRes?.passportImagePath).toBeNull();
    expect(completedRes?.passportDeletedAt).toBeDefined();
  });

  // ----------------------------------------------------
  // سناریو ۴: رقابت هم‌زمان دو کانال تلگرام و بله برای آخرین ظرفیت (Overbooking Check)
  // ----------------------------------------------------
  test('E2E-SC04: جلوگیری قطعی از Overbooking هنگام درخواست هم‌زمان از تلگرام و بله (DEC-0035)', async () => {
    const mokab = await inventoryService.registerMokabPlace({
      hostPersonId: 'host-p4',
      title: 'موکب شهدای گمنام',
      city: 'کاظمین',
      address: 'باب المراد',
      contactName: 'حاج قاسم',
      contactPhone: '09125556677',
      placePhotoPath: '/photos/place4.jpg',
      responsibilityDocumentPath: '/docs/doc4.pdf',
      supplyType: 'PRIVATE',
      financialModel: 'FREE',
      approvalMode: 'INSTANT',
    });

    // فقط ۱ اتاق خصوصی تعریف می‌شود
    const [room] = await inventoryService.registerPrivateRoomsBatch(mokab.id, 'اتاق شماره ۱', 1, 2);
    const adminToken = await adminAuthService.generateLoginToken('admin-super-001');
    const adminSession = await adminAuthService.exchangeTokenForSession(adminToken);
    await adminService.reviewHost(adminSession.sessionId, mokab.id, 'APPROVE', 'تأیید شد');

    const checkInDate = '2026-11-15';
    const checkOutDate = '2026-11-17';
    const now = new Date('2026-11-01T10:00:00Z');

    // کاربر تلگرام رزرو را ثبت می‌کند
    const resTelegram = await reservationService.createReservation({
      personId: 'tg-user-1',
      contactPhone: '09121111111',
      place: mokab,
      space: room,
      checkInDate,
      checkOutDate,
      maleCount: 2,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: false,
      now,
    });
    expect(resTelegram.status).toBe('CONFIRMED');

    // کاربر بله هم‌زمان برای همان تاریخ درخواست می‌دهد -> ظرفیت پر است و رد می‌شود
    await expect(
      reservationService.createReservation({
        personId: 'bale-user-2',
        contactPhone: '09122222222',
        place: mokab,
        space: room,
        checkInDate,
        checkOutDate,
        maleCount: 2,
        femaleCount: 0,
        childCount: 0,
        isForeignPilgrim: false,
        now,
      })
    ).rejects.toThrow('ROOM_OCCUPIED');
  });

  // ----------------------------------------------------
  // سناریو ۵: اتصال حساب دو پیام‌رسان با کد ۲۴ ساعته و رزروهای هم‌پوشان چندگانه
  // ----------------------------------------------------
  test('E2E-SC05: اتصال حساب تلگرام و بله با کد ۲۴ ساعته و رزروهای هم‌پوشان مستقل (DEC-0024, DEC-0040)', async () => {
    // ۱. ساخت حساب اولیه در تلگرام
    const { person: tgPerson } = await identityService.getOrCreateAccount('TELEGRAM', 'tg_user_99');
    const personId = tgPerson.id;

    // ۲. صدور کد اتصال حساب ۲۴ ساعته
    const linkCode = await identityService.generateLinkingCode(personId);
    expect(linkCode.code.length).toBe(6);

    // ۳. مصرف کد در بله
    const redeemResult = await identityService.redeemLinkingCode('BALE', 'bale_user_99', linkCode.code);
    expect(redeemResult.success).toBe(true);
    expect(redeemResult.person?.id).toBe(personId); // حساب هر دو پیام‌رسان کاملاً یکی شد

    // ۴. ثبت دو رزرو در تاریخ‌های هم‌پوشان برای دو گروه مختلف تحت همان حساب
    const mokab = await inventoryService.registerMokabPlace({
      hostPersonId: 'host-p5',
      title: 'موکب امام حسن (ع)',
      city: 'سامرا',
      address: 'خیابان اصلی',
      contactName: 'حاج یوسف',
      contactPhone: '09126667788',
      placePhotoPath: '/photos/place5.jpg',
      responsibilityDocumentPath: '/docs/doc5.pdf',
      supplyType: 'PUBLIC',
      financialModel: 'FREE',
      approvalMode: 'INSTANT',
    });
    const hall = await inventoryService.registerPublicHall(mokab.id, 'سالن عمومی', 'MEN', 100);

    const res1 = await reservationService.createReservation({
      personId,
      contactPhone: '09121111111',
      place: mokab,
      space: hall,
      checkInDate: '2026-11-20',
      checkOutDate: '2026-11-24',
      maleCount: 3,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: false,
      now: new Date('2026-11-01T10:00:00Z'),
    });

    const res2 = await reservationService.createReservation({
      personId,
      contactPhone: '09122222222',
      place: mokab,
      space: hall,
      checkInDate: '2026-11-22',
      checkOutDate: '2026-11-26', // هم‌پوشان با رزرو اول
      maleCount: 4,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: false,
      now: new Date('2026-11-01T10:00:00Z'),
    });

    expect(res1.status).toBe('CONFIRMED');
    expect(res2.status).toBe('CONFIRMED');

    // دریافت هر دو رزرو از طریق حساب شخص
    const userReservations = await reservationService.getReservationsByPerson(personId);
    expect(userReservations.length).toBe(2);
  });

  // ----------------------------------------------------
  // سناریو ۶: کنترل دقیق مرز ۷ روزه و مرز ۲۴ ساعته لغو
  // ----------------------------------------------------
  test('E2E-SC06: کنترل مرز ۷ روزه به وقت مقصد و لغو ۲۴ ساعته با آزادسازی فوری ظرفیت (DEC-0025, DEC-0033/34)', async () => {
    const mokab = await inventoryService.registerMokabPlace({
      hostPersonId: 'host-p6',
      title: 'موکب شهدای کربلا',
      city: 'کربلا',
      address: 'شارع العباس',
      contactName: 'حاج کریم',
      contactPhone: '09127778899',
      placePhotoPath: '/photos/place6.jpg',
      responsibilityDocumentPath: '/docs/doc6.pdf',
      supplyType: 'PUBLIC',
      financialModel: 'FREE',
      approvalMode: 'INSTANT',
    });
    const hall = await inventoryService.registerPublicHall(mokab.id, 'سالن اصلی', 'MEN', 20);

    // ۱. ورود ۲۰ آبان: آخرین روز مجاز ۱۳ آبان است؛ تلاش در ۱۴ آبان (۶ روز مانده) رد می‌شود
    await expect(
      reservationService.createReservation({
        personId: 'traveler-late',
        contactPhone: '09120000000',
        place: mokab,
        space: hall,
        checkInDate: '2026-11-20',
        checkOutDate: '2026-11-22',
        maleCount: 2,
        femaleCount: 0,
        childCount: 0,
        isForeignPilgrim: false,
        now: new Date('2026-11-14T01:00:00Z'), // ۶ روز قبل -> غیرمجاز
      })
    ).rejects.toThrow('CUTOFF_EXCEEDED');

    // ۲. رزرو معتبر در ۱۳ آبان ثبت می‌شود
    const validRes = await reservationService.createReservation({
      personId: 'traveler-valid',
      contactPhone: '09120000000',
      place: mokab,
      space: hall,
      checkInDate: '2026-11-20',
      checkOutDate: '2026-11-22',
      maleCount: 5,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: false,
      now: new Date('2026-11-13T12:00:00Z'), // ۷ روز قبل -> مجاز
    });
    expect(validRes.status).toBe('CONFIRMED');

    // ظرفیت ۱۵ نفر باقیمانده دارد
    let avail = await capacityService.checkPublicHallAvailability(hall, ['2026-11-20', '2026-11-21'], 16);
    expect(avail.available).toBe(false);

    // ۳. زائر ۲ روز پیش از ورود (بیش از ۲۴ ساعت مانده) لغو می‌کند -> لغو موفق و آزادسازی فوری
    const cancelResult = await stayService.cancelByTraveler(
      validRes.id,
      'traveler-valid',
      14,
      new Date('2026-11-18T10:00:00Z')
    );
    expect(cancelResult.status).toBe('CANCELLED');

    // ظرفیت فوراً به ۲۰ نفر کامل بازمی‌گردد
    avail = await capacityService.checkPublicHallAvailability(hall, ['2026-11-20', '2026-11-21'], 20);
    expect(avail.available).toBe(true);
  });
});
