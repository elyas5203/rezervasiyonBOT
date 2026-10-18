/**
 * آزمون‌های واحد چرخه حیات درخواست و چهار مسیر رزرو مسافر (MASTER-19)
 * معیارهای پذیرش BOOK-01 تا BOOK-08
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CapacityService } from '../core/capacity/capacity-service.js';
import { CreateReservationDTO, ReservationService } from '../core/reservation/reservation-service.js';
import { MokabPlace, Space } from '../core/types.js';

describe('MASTER-19 — آزمون‌های چرخه حیات درخواست و چهار مسیر رزرو زائر (Reservation Lifecycle)', () => {
  let capacityService: CapacityService;
  let reservationService: ReservationService;

  // زمان شبیه‌سازی: ۲۵ آبان ۱۴۰۵؛ ورود به موکب برای ۱۰ آذر ۱۴۰۵ (فاصله ۱۵ روزه یعنی کاملاً قبل از مرز ۷ روزه)
  const simulatedNow = new Date('2026-11-15T10:00:00Z');
  const checkInDate = '2026-11-30';
  const checkOutDate = '2026-12-02'; // ۲ شب اقامت

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
    cancellationRules: 'لغو تا ۴۸ ساعت قبل مجاز است؛ تضمین بازگردانده می‌شود.',
    createdAt: new Date()
  };

  const sampleHall: Space = {
    id: 'hall-1',
    placeId: 'place-mashhad-1',
    spaceType: 'PUBLIC_HALL',
    title: 'سالن آقایان',
    genderGroup: 'MEN',
    nominalCapacity: 30,
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
  });

  const baseDTO: CreateReservationDTO = {
    personId: 'person-traveler-1',
    contactPhone: '09121112233',
    place: basePlace,
    space: sampleHall,
    checkInDate,
    checkOutDate,
    maleCount: 2,
    femaleCount: 0,
    childCount: 0,
    isForeignPilgrim: false,
    now: simulatedNow
  };

  // BOOK-01: موکب فوری + رایگان -> قطعی آنی با کد رهگیری
  it('BOOK-01: مسیر ۱ (فوری + رایگان) باید آنی CONFIRMED شده و ظرفیت را قطعی کند', async () => {
    const instantFreePlace: MokabPlace = {
      ...basePlace,
      approvalMode: 'INSTANT',
      financialModel: 'FREE'
    };

    const reservation = await reservationService.createReservation({
      ...baseDTO,
      place: instantFreePlace
    });

    expect(reservation.status).toBe('CONFIRMED');
    expect(reservation.trackingCode.startsWith('RZ-')).toBe(true);
    expect(reservation.holdExpiresAt).toBeNull(); // پس از قطعی‌شدن، هولد به رزرو قطعی تبدیل می‌شود

    // بررسی ثبت قطعی در موتور ظرفیت
    const stayNights = capacityService.calculateStayNights(checkInDate, checkOutDate);
    const capacityCheck = await capacityService.checkPublicHallAvailability(sampleHall, stayNights, 29, simulatedNow);
    // سالن ۳۰ نفره بوده و ۲ نفر قطعی شده؛ پس ظرفیت آزاد ۲۸ است و درخواست ۲۹ نفر باید رد شود
    expect(capacityCheck.available).toBe(false);
  });

  // BOOK-02: موکب دستی + رایگان -> در انتظار قبول موکب‌دار
  it('BOOK-02: مسیر ۲ (دستی + رایگان) باید به PENDING_HOST_APPROVAL برود و با تأیید موکب‌دار قطعی شود', async () => {
    const manualFreePlace: MokabPlace = {
      ...basePlace,
      approvalMode: 'MANUAL',
      financialModel: 'FREE'
    };

    const reservation = await reservationService.createReservation({
      ...baseDTO,
      place: manualFreePlace
    });

    // مرحله ۱: وضعیت در انتظار تأیید موکب‌دار
    expect(reservation.status).toBe('PENDING_HOST_APPROVAL');
    expect(reservation.holdExpiresAt).toBeDefined();

    // مرحله ۲: موکب‌دار درخواست را تأیید می‌کند
    const reviewed = await reservationService.hostReviewReservation(
      reservation.id,
      manualFreePlace.hostPersonId,
      'ACCEPT',
      manualFreePlace,
      simulatedNow
    );

    expect(reviewed.status).toBe('CONFIRMED');
  });

  // BOOK-03: موکب فوری + پولی -> مستقیماً به انتظار واریز فیش
  it('BOOK-03: مسیر ۳ (فوری + پولی) باید مستقیماً وارد PENDING_PAYMENT_RECEIPT با مهلت ۲۴ ساعته شود', async () => {
    const instantPaidPlace: MokabPlace = {
      ...basePlace,
      approvalMode: 'INSTANT',
      financialModel: 'FIXED_FEE',
      feeAmountToman: 50000
    };

    const reservation = await reservationService.createReservation({
      ...baseDTO,
      place: instantPaidPlace
    });

    expect(reservation.status).toBe('PENDING_PAYMENT_RECEIPT');
    expect(reservation.holdExpiresAt).toBeDefined();

    // مهلت باید دقیقاً ۲۴ ساعت بعد از زمان ثبت باشد (DEC-0025)
    const expectedExpiry = new Date(simulatedNow.getTime() + 24 * 60 * 60 * 1000);
    expect(reservation.holdExpiresAt?.getTime()).toBe(expectedExpiry.getTime());
  });

  // BOOK-04: موکب دستی + پولی -> ابتدا تأیید موکب‌دار (بدون پول) و سپس ورود به مهلت پرداخت
  it('BOOK-04: مسیر ۴ (دستی + پولی) ابتدا باید بدون درخواست پول به تأیید موکب‌دار برود و سپس وارد گام پرداخت شود', async () => {
    const manualPaidPlace: MokabPlace = {
      ...basePlace,
      approvalMode: 'MANUAL',
      financialModel: 'FIXED_DEPOSIT',
      depositAmountToman: 100000
    };

    const reservation = await reservationService.createReservation({
      ...baseDTO,
      place: manualPaidPlace
    });

    // ۱. ابتدا باید در انتظار تأیید موکب باشد و پولی خواسته نشود
    expect(reservation.status).toBe('PENDING_HOST_APPROVAL');

    // ۲. پس از تأیید موکب‌دار، وضعیت به انتظار واریز فیش تغییر می‌یابد
    const reviewed = await reservationService.hostReviewReservation(
      reservation.id,
      manualPaidPlace.hostPersonId,
      'ACCEPT',
      manualPaidPlace,
      simulatedNow
    );

    expect(reviewed.status).toBe('PENDING_PAYMENT_RECEIPT');
    expect(reviewed.holdExpiresAt).toBeDefined();
  });

  // BOOK-05: زائر خارجی با گذرنامه و بدون پول -> در هر صورت نیازمند تأیید موکب‌دار (DEC-0032)
  it('BOOK-05: زائر خارجی بدون پرداخت و با تصویر گذرنامه حتی در موکب فوری به PENDING_HOST_APPROVAL می‌رود', async () => {
    const instantPlace: MokabPlace = {
      ...basePlace,
      approvalMode: 'INSTANT' // حتی اگر موکب فوری باشد!
    };

    // سناریو الف: زائر خارجی بدون گذرنامه باید رد شود
    expect(reservationService.createReservation({
      ...baseDTO,
      place: instantPlace,
      isForeignPilgrim: true,
      passportImagePath: ''
    })).rejects.toThrow('MISSING_PASSPORT');

    // سناریو ب: زائر خارجی با گذرنامه معتبر
    const foreignReservation = await reservationService.createReservation({
      ...baseDTO,
      place: instantPlace,
      isForeignPilgrim: true,
      passportImagePath: '/uploads/passports/foreign1.jpg'
    });

    // باید به انتظار تأیید موکب‌دار برود نه تأیید آنی
    expect(foreignReservation.status).toBe('PENDING_HOST_APPROVAL');
    expect(foreignReservation.isForeignPilgrim).toBe(true);
    expect(foreignReservation.passportImagePath).toBe('/uploads/passports/foreign1.jpg');

    // تأیید موکب‌دار منجر به قطعی‌شدن می‌شود
    const approved = await reservationService.hostReviewReservation(
      foreignReservation.id,
      instantPlace.hostPersonId,
      'ACCEPT',
      instantPlace,
      simulatedNow
    );
    expect(approved.status).toBe('CONFIRMED');
  });

  // BOOK-06: ظرفیت در طول گام‌های انتظار قفل می‌ماند و با رد درخواست آزاد می‌شود
  it('BOOK-06: نگه‌داشت ظرفیت در انتظار و آزادسازی فوری آن در صورت رد موکب‌دار', async () => {
    const manualFreePlace: MokabPlace = {
      ...basePlace,
      approvalMode: 'MANUAL',
      financialModel: 'FREE'
    };

    // رزرو کل اتاق ۴ نفره
    const reservation = await reservationService.createReservation({
      ...baseDTO,
      place: manualFreePlace,
      space: sampleRoom,
      maleCount: 4
    });

    expect(reservation.status).toBe('PENDING_HOST_APPROVAL');

    // اتاق در طول انتظار قفل است و دیگری نمی‌تواند رزرو کند
    const isRoomFree = await capacityService.checkPrivateRoomAvailability(
      sampleRoom,
      ['2026-11-30', '2026-12-01'],
      simulatedNow
    );
    expect(isRoomFree).toBe(false);

    // موکب‌دار درخواست را رد می‌کند
    const rejected = await reservationService.hostReviewReservation(
      reservation.id,
      manualFreePlace.hostPersonId,
      'REJECT',
      manualFreePlace,
      simulatedNow
    );

    expect(rejected.status).toBe('CANCELLED');

    // اکنون اتاق بلافاصله آزاد شده است
    const isRoomFreeAfterReject = await capacityService.checkPrivateRoomAvailability(
      sampleRoom,
      ['2026-11-30', '2026-12-01'],
      simulatedNow
    );
    expect(isRoomFreeAfterReject).toBe(true);
  });

  // BOOK-07: مجاز بودن رزروهای هم‌پوشان برای یک حساب (DEC-0024)
  it('BOOK-07: یک حساب می‌تواند چند رزرو در تاریخ‌های هم‌پوشان برای افراد مختلف ثبت کند', async () => {
    // رزرو اول برای ۲ نفر
    const res1 = await reservationService.createReservation({
      ...baseDTO,
      personId: 'user-shared-account',
      maleCount: 2
    });
    expect(res1.status).toBe('CONFIRMED');

    // رزرو دوم در همان تاریخ‌ها برای بستگان (۳ نفر دیگر)
    const res2 = await reservationService.createReservation({
      ...baseDTO,
      personId: 'user-shared-account',
      maleCount: 3
    });
    expect(res2.status).toBe('CONFIRMED');

    // هر دو رزرو در لیست رزروهای کاربر وجود دارند
    const userReservations = await reservationService.getReservationsByPerson('user-shared-account');
    expect(userReservations.length).toBe(2);
    expect(userReservations[0].id).not.toBe(userReservations[1].id);
  });

  // BOOK-08: ثبت شماره تماس زائر و فریز شدن متن قانون لغو موکب (DEC-0014, DEC-0043)
  it('BOOK-08: فریز شدن قانون لغو موکب در رکورد رزرو و ثبت شماره تماس', async () => {
    const reservation = await reservationService.createReservation({
      ...baseDTO,
      contactPhone: '09359876543'
    });

    expect(reservation.contactPhone).toBe('09359876543');
    expect(reservation.cancellationRulesSnapshot).toBe(basePlace.cancellationRules);

    // اگر موکب‌دار در آینده قانون لغو خود را تغییر دهد، رزرو قبلی قانون گذشته را حفظ می‌کند
    const modifiedPlace: MokabPlace = {
      ...basePlace,
      cancellationRules: 'قانون جدید: هیچ لغوی پذیرفته نیست و مبلغ عودت داده نمی‌شود!'
    };

    const oldRes = await reservationService.getReservationById(reservation.id);
    expect(oldRes?.cancellationRulesSnapshot).toBe('لغو تا ۴۸ ساعت قبل مجاز است؛ تضمین بازگردانده می‌شود.');
  });
});
