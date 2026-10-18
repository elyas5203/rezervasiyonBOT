/**
 * آزمون‌های واحد عملیات اقامت، لغو، عدم حضور، پاکسازی ۳۰ روزه گذرنامه و اعلان‌ها (MASTER-21)
 * معیارهای پذیرش STAY-01 تا STAY-06
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CapacityService } from '../core/capacity/capacity-service.js';
import { NotificationService } from '../core/notification/notification-service.js';
import { ReservationService } from '../core/reservation/reservation-service.js';
import { StayService } from '../core/stay/stay-service.js';
import { MokabPlace, ReservationRequest, Space } from '../core/types.js';

describe('MASTER-21 — آزمون‌های عملیات اقامت، لغو ۲۴ ساعته، عدم حضور، پاکسازی گذرنامه و اعلان‌ها', () => {
  let capacityService: CapacityService;
  let reservationService: ReservationService;
  let notificationService: NotificationService;
  let stayService: StayService;

  const simulatedNow = new Date('2026-11-15T10:00:00Z');
  const checkInDate = '2026-11-30';
  const checkOutDate = '2026-12-02';

  const basePlace: MokabPlace = {
    id: 'place-mashhad-1',
    hostPersonId: 'host-1',
    title: 'موکب امام رضا (ع)',
    city: 'مشهد',
    address: 'خیابان طبرسی',
    contactName: 'حاج رضا',
    contactPhone: '09151112233',
    status: 'APPROVED',
    supplyType: 'BOTH',
    financialModel: 'FREE',
    approvalMode: 'INSTANT',
    feeAmountToman: 0,
    depositAmountToman: 0,
    cancellationRules: 'لغو تا ۴۸ ساعت قبل مجاز است.',
    createdAt: new Date()
  };

  const sampleRoom: Space = {
    id: 'room-1',
    placeId: 'place-mashhad-1',
    spaceType: 'PRIVATE_ROOM',
    title: 'اتاق ۴ نفره',
    genderGroup: 'ALL',
    nominalCapacity: 4,
    createdAt: new Date()
  };

  beforeEach(() => {
    capacityService = new CapacityService();
    reservationService = new ReservationService(capacityService);
    notificationService = new NotificationService();
    stayService = new StayService(reservationService, capacityService, notificationService);
  });

  // STAY-01: ثبت ورود و خروج مسافر و تغییر به COMPLETED بدون ادعای بازپرداخت (DEC-0021)
  it('STAY-01: ثبت ورود و خروج مسافر بدون تولید هیچ وضعیت یا متد بازپرداختی', async () => {
    const reservation = await reservationService.createReservation({
      personId: 'traveler-1',
      contactPhone: '09121111111',
      place: basePlace,
      space: sampleRoom,
      checkInDate,
      checkOutDate,
      maleCount: 2,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: false,
      now: simulatedNow
    });

    expect(reservation.status).toBe('CONFIRMED');

    // ثبت ورود مسافر
    const checkInTime = new Date('2026-11-30T14:30:00Z');
    await stayService.checkIn(reservation.id, basePlace.hostPersonId, checkInTime);

    // ثبت خروج مسافر
    const checkOutTime = new Date('2026-12-02T11:00:00Z');
    const completed = await stayService.checkOut(reservation.id, basePlace.hostPersonId, checkOutTime);

    expect(completed.status).toBe('COMPLETED');
    // بررسی عدم وجود فیلد بازپرداخت
    expect((completed as any).refundAmount).toBeUndefined();
    expect((completed as any).refundStatus).toBeUndefined();
  });

  // STAY-02: لغو توسط مسافر تا ۲۴ ساعت پیش از ورود مجاز است و کمتر از ۲۴ ساعت رد می‌شود (DEC-0025)
  it('STAY-02: کنترل دقیق مرز ۲۴ ساعته لغو و آزادسازی فوری ظرفیت', async () => {
    const reservation = await reservationService.createReservation({
      personId: 'traveler-cancel-test',
      contactPhone: '09121111111',
      place: basePlace,
      space: sampleRoom,
      checkInDate,
      checkOutDate,
      maleCount: 4,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: false,
      now: simulatedNow
    });

    // ورود برنامه‌ریزی‌شده: 2026-11-30 ساعت ۱۴:۰۰
    // حالت الف: تلاش برای لغو در ۲۹ آبان ساعت ۱۶:۰۰ (تنها ۲۲ ساعت مانده به ورود -> کمتر از ۲۴ ساعت)
    const lateCancelTime = new Date('2026-11-29T16:00:00Z');
    expect(stayService.cancelByTraveler(
      reservation.id,
      'traveler-cancel-test',
      14,
      lateCancelTime
    )).rejects.toThrow('CANCELLATION_DEADLINE_PASSED');

    // حالت ب: لغو به‌موقع در ۲۸ آبان (۴۸ ساعت مانده به ورود)
    const validCancelTime = new Date('2026-11-28T10:00:00Z');
    const cancelled = await stayService.cancelByTraveler(
      reservation.id,
      'traveler-cancel-test',
      14,
      validCancelTime
    );

    expect(cancelled.status).toBe('CANCELLED');

    // ظرفیت اتاق باید فوراً آزاد شده باشد
    const isRoomFree = await capacityService.checkPrivateRoomAvailability(
      sampleRoom,
      ['2026-11-30', '2026-12-01'],
      validCancelTime
    );
    expect(isRoomFree).toBe(true);
  });

  // STAY-03: ثبت عدم حضور پس از ۲۴ ساعت از زمان ورود و رد ثبت زودهنگام (DEC-0025)
  it('STAY-03: ثبت عدم حضور مسافر فقط پس از ۲۴ ساعت از ساعت ورود مجاز است', async () => {
    const reservation = await reservationService.createReservation({
      personId: 'traveler-noshow-test',
      contactPhone: '09121111111',
      place: basePlace,
      space: sampleRoom,
      checkInDate,
      checkOutDate,
      maleCount: 4,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: false,
      now: simulatedNow
    });

    // ساعت ورود: 2026-11-30T14:00:00Z
    // تلاش برای ثبت عدم حضور ۵ ساعت بعد (ساعت ۱۹ همان روز -> نارس و زودهنگام)
    const prematureTime = new Date('2026-11-30T19:00:00Z');
    expect(stayService.markNoShow(
      reservation.id,
      basePlace.hostPersonId,
      14,
      prematureTime
    )).rejects.toThrow('NO_SHOW_PREMATURE');

    // ثبت عدم حضور پس از ۲۵ ساعت (2026-12-01 ساعت ۱۵:۰۰)
    const validNoShowTime = new Date('2026-12-01T15:00:00Z');
    const noShowRes = await stayService.markNoShow(
      reservation.id,
      basePlace.hostPersonId,
      14,
      validNoShowTime
    );

    expect(noShowRes.status).toBe('NO_SHOW');
  });

  // STAY-04: جاب پاکسازی دوره‌ای گذرنامه‌های زائران خارجی پس از ۳۰ روز (DEC-0036, DEC-0037)
  it('STAY-04: پاکسازی تصویر گذرنامه زائر خارجی پس از ۳۰ روز از اتمام پرونده', async () => {
    const closedDate = new Date('2026-11-01T10:00:00Z');

    const foreignReservations: ReservationRequest[] = [
      {
        id: 'res-f1',
        trackingCode: 'RZ-F11111',
        personId: 'foreign-user-1',
        contactPhone: '+9647701111111',
        placeId: basePlace.id,
        spaceId: sampleRoom.id,
        checkInDate: '2026-10-25',
        checkOutDate: '2026-10-28',
        maleCount: 2,
        femaleCount: 0,
        childCount: 0,
        totalCount: 2,
        status: 'COMPLETED',
        cancellationRulesSnapshot: 'قانون موکب',
        isForeignPilgrim: true,
        passportImagePath: '/uploads/passports/f1.jpg',
        passportDeletedAt: null,
        createdAt: closedDate,
        updatedAt: closedDate
      },
      {
        id: 'res-f2',
        trackingCode: 'RZ-F22222',
        personId: 'foreign-user-2',
        contactPhone: '+9647702222222',
        placeId: basePlace.id,
        spaceId: sampleRoom.id,
        checkInDate: '2026-10-20',
        checkOutDate: '2026-10-22',
        maleCount: 1,
        femaleCount: 0,
        childCount: 0,
        totalCount: 1,
        status: 'CANCELLED', // لغو شده بدون اقامت
        cancellationRulesSnapshot: 'قانون موکب',
        isForeignPilgrim: true,
        passportImagePath: '/uploads/passports/f2.jpg',
        passportDeletedAt: null,
        createdAt: closedDate,
        updatedAt: closedDate
      }
    ];

    // اجرای جاب در روز ۱۰ نوامبر (تنها ۹ روز گذشته -> کمتر از ۳۰ روز)
    const day9 = new Date('2026-11-10T10:00:00Z');
    let cleaned = await stayService.cleanupExpiredPassports(foreignReservations, day9);
    expect(cleaned).toBe(0);
    expect(foreignReservations[0].passportImagePath).toBe('/uploads/passports/f1.jpg');

    // اجرای جاب در روز ۳ دسامبر (۳۲ روز گذشته -> بیش از ۳۰ روز)
    const day32 = new Date('2026-12-03T10:00:00Z');
    cleaned = await stayService.cleanupExpiredPassports(foreignReservations, day32);
    expect(cleaned).toBe(2);

    // تصویر گذرنامه هر دو پرونده باید null شده و تاریخ حذف ثبت شده باشد
    expect(foreignReservations[0].passportImagePath).toBeNull();
    expect(foreignReservations[0].passportDeletedAt).toEqual(day32);
    expect(foreignReservations[1].passportImagePath).toBeNull();
    expect(foreignReservations[1].passportDeletedAt).toEqual(day32);
  });

  // STAY-05: شکست در ارسال اعلان خللی در وضعیت‌های دیتابیس ایجاد نمی‌کند (DEC-0016)
  it('STAY-05: شکست در درگاه پیام‌رسان تراکنش بیزینس را دچار عقب‌گرد نمی‌کند', async () => {
    // فعال‌سازی شبیه‌سازی قطعی پیام‌رسان
    notificationService.simulateFailure = true;

    const reservation = await reservationService.createReservation({
      personId: 'traveler-resilient-test',
      contactPhone: '09121111111',
      place: basePlace,
      space: sampleRoom,
      checkInDate,
      checkOutDate,
      maleCount: 2,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: false,
      now: simulatedNow
    });

    // عملیات خروج با وجود قطعی پیام‌رسان باید با موفقیت به پایان برسد
    const completed = await stayService.checkOut(
      reservation.id,
      basePlace.hostPersonId,
      new Date('2026-12-02T11:00:00Z')
    );

    // وضعیت در دیتابیس قطعی و COMPLETED است
    expect(completed.status).toBe('COMPLETED');

    // لاگ اعلان باید شکست ارسال را ثبت کرده باشد بدون اینکه برنامه متوقف شده باشد
    const logs = notificationService.getNotificationLogs();
    const lastLog = logs[logs.length - 1];
    expect(lastLog.isDelivered).toBe(false);
    expect(lastLog.error).toBeDefined();
  });

  // STAY-06: متن اعلان‌ها فاقد شماره کارت و گذرنامه است
  it('STAY-06: متن اعلان‌ها امن بوده و حاوی اطلاعات حساس یا شماره کارت نیست', async () => {
    const reservation = await reservationService.createReservation({
      personId: 'traveler-safe-test',
      contactPhone: '09121111111',
      place: basePlace,
      space: sampleRoom,
      checkInDate,
      checkOutDate,
      maleCount: 2,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: false,
      now: simulatedNow
    });

    const safeText = notificationService.buildSafeMessageText(reservation, 'CONFIRMED');
    expect(safeText).toContain(reservation.trackingCode);
    expect(safeText).not.toContain('/uploads/');
    expect(safeText).not.toMatch(/\b\d{16}\b/);
  });
});
