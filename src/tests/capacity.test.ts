/**
 * آزمون‌های واحد موتور تقویم، مدت، کنترل ظرفیت و نگه‌داشت موقت (MASTER-18)
 * معیارهای پذیرش CAP-01 تا CAP-07
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CapacityService } from '../core/capacity/capacity-service.js';
import { Space } from '../core/types.js';

describe('MASTER-18 — آزمون‌های موتور تقویم، کنترل ظرفیت و نگه‌داشت (Capacity Engine)', () => {
  let capacityService: CapacityService;

  const mockPublicHall: Space = {
    id: 'hall-men-1',
    placeId: 'place-mashhad-1',
    spaceType: 'PUBLIC_HALL',
    title: 'سالن بزرگ آقایان',
    genderGroup: 'MEN',
    nominalCapacity: 20,
    createdAt: new Date()
  };

  const mockPrivateRoom4: Space = {
    id: 'room-4-1',
    placeId: 'place-mashhad-1',
    spaceType: 'PRIVATE_ROOM',
    title: 'اتاق ۴ نفره لاله',
    genderGroup: 'ALL',
    nominalCapacity: 4,
    createdAt: new Date()
  };

  const mockPrivateRoom10: Space = {
    id: 'room-10-1',
    placeId: 'place-mashhad-1',
    spaceType: 'PRIVATE_ROOM',
    title: 'اتاق ۱۰ نفره بهار',
    genderGroup: 'ALL',
    nominalCapacity: 10,
    createdAt: new Date()
  };

  beforeEach(() => {
    capacityService = new CapacityService();
  });

  // CAP-01: ورود ۱۰ تا ۱۲ آبان (۲ شب)؛ اگر شب دوم پر باشد باید رد شود (خالی بودن شب اول کافی نیست)
  it('CAP-01: اگر شب دوم از بازه چندشبه پر باشد، درخواست کل بازه باید رد شود', async () => {
    const stayNights = capacityService.calculateStayNights('2026-11-01', '2026-11-03');
    expect(stayNights).toEqual(['2026-11-01', '2026-11-02']); // دقیقاً ۲ شب: شب اول و شب دوم

    // شب دوم (2026-11-02) را با یک هولد ۲۰ نفره کاملاً پر می‌کنیم
    await capacityService.createCapacityHold(mockPublicHall, {
      placeId: mockPublicHall.placeId,
      spaceId: mockPublicHall.id,
      stayNights: ['2026-11-02'],
      personCount: 20,
      genderGroup: 'MEN'
    });

    // استعلام برای هر دو شب با درخواست ۵ نفر
    const check = await capacityService.checkPublicHallAvailability(mockPublicHall, stayNights, 5);

    // نتیجه باید عدم امکان رزرو باشد چون شب دوم پر است
    expect(check.available).toBe(false);
    expect(check.freeCapacityPerNight['2026-11-01']).toBe(20); // شب اول کاملاً خالی است
    expect(check.freeCapacityPerNight['2026-11-02']).toBe(0);  // شب دوم کاملاً پر است

    // تلاش برای ایجاد هولد در کل بازه باید خطای کمبود ظرفیت دهد
    expect(capacityService.createCapacityHold(mockPublicHall, {
      placeId: mockPublicHall.placeId,
      spaceId: mockPublicHall.id,
      stayNights,
      personCount: 5,
      genderGroup: 'MEN'
    })).rejects.toThrow('CAPACITY_EXCEEDED');
  });

  // CAP-02: درخواست گروه ۵ نفره برای اتاق ۴ نفره حتی با کودک باید رد شود (کودک شمرده می‌شود DEC-0027)
  it('CAP-02: درخواست ۵ نفر برای اتاق با ظرفیت اسمی ۴ باید رد شود (شمارش کودک بدون استثنا)', async () => {
    const stayNights = capacityService.calculateStayNights('2026-11-10', '2026-11-12');

    // تلاش برای ایجاد هولد ۵ نفره در اتاق ۴ نفره
    expect(capacityService.createCapacityHold(mockPrivateRoom4, {
      placeId: mockPrivateRoom4.placeId,
      spaceId: mockPrivateRoom4.id,
      stayNights,
      personCount: 5, // ۴ بزرگسال + ۱ کودک = ۵ نفر اسمی
      genderGroup: 'ALL'
    })).rejects.toThrow('CAPACITY_EXCEEDED');
  });

  // CAP-03: آخرین ظرفیت خالی؛ اولین درخواست هولد می‌گیرد و دومین درخواست هم‌زمان رد می‌شود (Overbooking Guard)
  it('CAP-03: جلوگیری از رزرو مازاد (Overbooking) در آخرین ظرفیت موجود بین دو کانال', async () => {
    const stayNights = ['2026-11-15'];

    // اتاق خصوصی فقط ۱ ظرفیت پذیرش دارد
    // درخواست اول (مثلاً از تلگرام)
    const hold1 = await capacityService.createCapacityHold(mockPrivateRoom4, {
      placeId: mockPrivateRoom4.placeId,
      spaceId: mockPrivateRoom4.id,
      stayNights,
      personCount: 4,
      genderGroup: 'ALL'
    });
    expect(hold1.status).toBe('ACTIVE');

    // درخواست دوم (مثلاً از بله) هم‌زمان برای همان شب
    expect(capacityService.createCapacityHold(mockPrivateRoom4, {
      placeId: mockPrivateRoom4.placeId,
      spaceId: mockPrivateRoom4.id,
      stayNights,
      personCount: 3,
      genderGroup: 'ALL'
    })).rejects.toThrow('ROOM_OCCUPIED');
  });

  // CAP-04: درخواست اقامت ۴ شب برای موکبی با سقف ۳ شب باید رد شود (DEC-0009)
  it('CAP-04: اقامت فراتر از سقف اعلامی موکب باید رد شود', async () => {
    await capacityService.setPlaceOperatingRules({
      placeId: 'place-mashhad-1',
      maxStayNights: 3,
      checkInHour: 14,
      checkOutHour: 12
    });

    // ۴ شب اقامت
    const fourNights = capacityService.calculateStayNights('2026-11-01', '2026-11-05');
    expect(fourNights.length).toBe(4);

    const isAllowed4 = await capacityService.validateStayDuration('place-mashhad-1', fourNights);
    expect(isAllowed4).toBe(false);

    // ۳ شب اقامت
    const threeNights = capacityService.calculateStayNights('2026-11-01', '2026-11-04');
    expect(threeNights.length).toBe(3);

    const isAllowed3 = await capacityService.validateStayDuration('place-mashhad-1', threeNights);
    expect(isAllowed3).toBe(true);
  });

  // CAP-05: درخواست کمتر از ۷ روز مانده به ورود باید رد شود (DEC-0033, DEC-0034)
  it('CAP-05: کنترل دقیق مرز ۷ روز پیش از ورود به وقت شهر مقصد', () => {
    const checkInDate = '2026-11-10'; // ۲۰ آبان

    // ۱. ثبت در روز ۱۳ آبان (2026-11-03) یعنی ۷ روز قبل -> مجاز
    const timeOnDay7Before = new Date('2026-11-03T18:00:00Z');
    const allowed = capacityService.isDateAllowedByCutoff(checkInDate, timeOnDay7Before, 'مشهد');
    expect(allowed).toBe(true);

    // ۲. ثبت در روز ۱۴ آبان (2026-11-04) یعنی ۶ روز قبل -> غیرمجاز
    const timeOnDay6Before = new Date('2026-11-04T08:00:00Z');
    const forbidden = capacityService.isDateAllowedByCutoff(checkInDate, timeOnDay6Before, 'مشهد');
    expect(forbidden).toBe(false);
  });

  // CAP-06: نگه‌داشت ۲۴ ساعته پس از انقضا یا پس از آزادسازی ظرفیت را برمی‌گرداند
  it('CAP-06: آزادسازی هولد موقت (Release) یا انقضای ۲۴ ساعته باید ظرفیت را آزاد کند', async () => {
    const stayNights = ['2026-11-20'];
    const now = new Date('2026-11-01T10:00:00Z');

    // ایجاد هولد ۲۰ نفره در سالن ۲۰ نفره
    const hold = await capacityService.createCapacityHold(mockPublicHall, {
      placeId: mockPublicHall.placeId,
      spaceId: mockPublicHall.id,
      stayNights,
      personCount: 20,
      genderGroup: 'MEN'
    }, now);

    // بررسی پر بودن سالن
    let check = await capacityService.checkPublicHallAvailability(mockPublicHall, stayNights, 1, now);
    expect(check.available).toBe(false);

    // سناریو ۱: آزادسازی دستی هولد (مثلاً رد توسط موکب‌دار یا لغو زائر)
    await capacityService.releaseHold(hold.id, 'رد توسط موکب‌دار');
    check = await capacityService.checkPublicHallAvailability(mockPublicHall, stayNights, 20, now);
    expect(check.available).toBe(true);

    // سناریو ۲: انقضای زمانی هولد پس از ۲۴ ساعت
    const hold2 = await capacityService.createCapacityHold(mockPublicHall, {
      placeId: mockPublicHall.placeId,
      spaceId: mockPublicHall.id,
      stayNights,
      personCount: 20,
      genderGroup: 'MEN'
    }, now);

    // ۲۵ ساعت بعد
    const futureNow = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    check = await capacityService.checkPublicHallAvailability(mockPublicHall, stayNights, 20, futureNow);
    // هولد منقضی شده و در محاسبه ظرفیت آزاد شمرده نمی‌شود
    expect(check.available).toBe(true);
  });

  // CAP-07: رزرو اتاق ۱۰ نفره توسط ۴ نفر کل اتاق را مسدود کند و باقی‌مانده عرضه نشود
  it('CAP-07: اتاق خصوصی دربست است و ظرفیت باقی‌مانده به دیگران عرضه نمی‌شود', async () => {
    const stayNights = ['2026-11-25'];

    // گروه ۴ نفره یک اتاق ۱۰ نفره را می‌گیرند
    const hold = await capacityService.createCapacityHold(mockPrivateRoom10, {
      placeId: mockPrivateRoom10.placeId,
      spaceId: mockPrivateRoom10.id,
      stayNights,
      personCount: 4,
      genderGroup: 'ALL'
    });
    expect(hold.status).toBe('ACTIVE');

    // استعلام برای فرد یا گروه دیگر حتی ۱ نفر باید نشان دهد اتاق در دسترس نیست
    const isFree = await capacityService.checkPrivateRoomAvailability(mockPrivateRoom10, stayNights);
    expect(isFree).toBe(false);
  });
});
