/**
 * آزمون‌های واحد ماژول موکب، سالن و اتاق‌ها (MASTER-17)
 * معیارهای پذیرش HOST-01 تا HOST-06
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { InventoryService, RegisterMokabDTO } from '../core/inventory/inventory-service.js';

describe('MASTER-17 — آزمون‌های ثبت موکب، سالن و اتاق و تأیید ادمین', () => {
  let inventoryService: InventoryService;

  const validMokabBase: RegisterMokabDTO = {
    hostPersonId: 'person-host-1',
    title: 'موکب امام رضا (ع)',
    city: 'مشهد',
    address: 'خیابان شیرازی، کوچه صاحب‌الزمان',
    contactName: 'حاج علی اکبری',
    contactPhone: '09123456789',
    placePhotoPath: '/uploads/photos/mokab1.jpg',
    responsibilityDocumentPath: '/uploads/docs/letter1.pdf',
    supplyType: 'BOTH',
    financialModel: 'FREE',
    approvalMode: 'MANUAL',
    cancellationRules: 'لغو تا ۴۸ ساعت قبل بدون مشکل است.'
  };

  beforeEach(() => {
    inventoryService = new InventoryService();
  });

  // HOST-01: ثبت دسته‌ای ۳ اتاق ۴ نفره منجر به ایجاد ۳ رکورد مستقل با ظرفیت ۴ شود
  it('HOST-01: ثبت دسته‌ای ۳ اتاق ۴ نفره باید ۳ رکورد مستقل با ظرفیت ۴ بسازد (نه یک اتاق ۱۲ نفره)', async () => {
    const place = await inventoryService.registerMokabPlace(validMokabBase);
    const rooms = await inventoryService.registerPrivateRoomsBatch(place.id, 'اتاق لاله', 3, 4);

    expect(rooms.length).toBe(3);
    // هر اتاق باید رکورد مستقل فیزیکی با ظرفیت ۴ باشد
    for (const room of rooms) {
      expect(room.spaceType).toBe('PRIVATE_ROOM');
      expect(room.nominalCapacity).toBe(4);
      expect(room.placeId).toBe(place.id);
    }

    // شناسه‌ها باید متمایز باشند
    const ids = new Set(rooms.map(r => r.id));
    expect(ids.size).toBe(3);

    // جمع کل ظرفیت فضاها نباید باعث ادغام شناسه شود
    const allSpaces = await inventoryService.getSpacesByPlaceId(place.id);
    expect(allSpaces.length).toBe(3);
  });

  // HOST-02: افزودن اتاق‌های ۱۰ نفره جدید به اتاق‌های قبلی لطمه‌ای نزند
  it('HOST-02: افزودن گروه جدید اتاق‌های ۱۰ نفره باید رکوردهای مجزا بسازد بدون دستکاری اتاق‌های قبل', async () => {
    const place = await inventoryService.registerMokabPlace(validMokabBase);

    // مرحله ۱: ۳ اتاق ۴ نفره
    const rooms4 = await inventoryService.registerPrivateRoomsBatch(place.id, 'اتاق چهارنفره', 3, 4);
    expect(rooms4.length).toBe(3);

    // مرحله ۲: ۲ اتاق ۱۰ نفره
    const rooms10 = await inventoryService.registerPrivateRoomsBatch(place.id, 'اتاق ده‌نفره', 2, 10);
    expect(rooms10.length).toBe(2);

    for (const room of rooms10) {
      expect(room.nominalCapacity).toBe(10);
    }

    // بررسی کل ۵ اتاق مستقل
    const allSpaces = await inventoryService.getSpacesByPlaceId(place.id);
    expect(allSpaces.length).toBe(5);

    const capacities = allSpaces.map(s => s.nominalCapacity);
    expect(capacities.filter(c => c === 4).length).toBe(3);
    expect(capacities.filter(c => c === 10).length).toBe(2);
  });

  // HOST-03: موکب در وضعیت PENDING یا REJECTED نباید در getApprovedPlaces ظاهر شود
  it('HOST-03: موکب تأییدنشده (PENDING یا REJECTED) باید از جست‌وجو پنهان بماند', async () => {
    const place = await inventoryService.registerMokabPlace(validMokabBase);
    expect(place.status).toBe('PENDING');

    // قبل از تأیید، جست‌وجوی عمومی خالی است
    let approved = await inventoryService.getApprovedPlaces('مشهد');
    expect(approved.length).toBe(0);

    // پس از رد، همچنان پنهان می‌ماند
    await inventoryService.reviewMokabPlace(place.id, 'admin-1', 'REJECTED', 'نقص در مدارک');
    approved = await inventoryService.getApprovedPlaces('مشهد');
    expect(approved.length).toBe(0);
  });

  // HOST-04: سالن عمومی آقایان و بانوان تفکیک جنسیتی مستقل داشته باشند
  it('HOST-04: سالن‌های عمومی باید با تفکیک جنسیتی مستقل و ظرفیت اختصاصی ثبت شوند', async () => {
    const place = await inventoryService.registerMokabPlace(validMokabBase);

    const hallMen = await inventoryService.registerPublicHall(place.id, 'سالن شهدای گمنام (آقایان)', 'MEN', 50);
    const hallWomen = await inventoryService.registerPublicHall(place.id, 'سالن کوثر (بانوان)', 'WOMEN', 50);

    expect(hallMen.genderGroup).toBe('MEN');
    expect(hallMen.nominalCapacity).toBe(50);

    expect(hallWomen.genderGroup).toBe('WOMEN');
    expect(hallWomen.nominalCapacity).toBe(50);

    const spaces = await inventoryService.getSpacesByPlaceId(place.id);
    expect(spaces.length).toBe(2);
  });

  // HOST-05: مدارک ۴گانه برای شهرهای مختلف کافی است و شهرهای عربستان رد می‌شوند
  it('HOST-05: پذیرش شهرهای زیارتی مختلف و رد صریح شهرهای عربستان (DEC-0002, DEC-0041)', async () => {
    // ۱. شهر نجف (عراق) با همان مدارک پایه پذیرفته می‌شود
    const najafPlace = await inventoryService.registerMokabPlace({
      ...validMokabBase,
      title: 'موکب نجف اشرف',
      city: 'نجف',
      address: 'شارع الحولی، عمود ۲۰۰'
    });
    expect(najafPlace.id).toBeDefined();
    expect(najafPlace.city).toBe('نجف');

    // ۲. شهر مکه یا مدینه (عربستان) باید طبق DEC-0002 رد شود
    expect(inventoryService.registerMokabPlace({
      ...validMokabBase,
      title: 'موکب مدینه منوره',
      city: 'مدینه',
      address: 'نزدیک مسجد النبی'
    })).rejects.toThrow('FORBIDDEN_CITY');

    expect(inventoryService.registerMokabPlace({
      ...validMokabBase,
      title: 'موکب مکه مکرمه',
      city: 'مکه',
      address: 'شارع عزیزیه'
    })).rejects.toThrow('FORBIDDEN_CITY');
  });

  // HOST-06: تأیید موکب توسط ادمین و انتشار آن در جست‌وجوی عمومی
  it('HOST-06: تأیید ادمین باید وضعیت را به APPROVED تغییر داده و موکب را در جست‌وجو نمایان کند', async () => {
    const place = await inventoryService.registerMokabPlace(validMokabBase);

    // تأیید توسط ادمین
    const reviewed = await inventoryService.reviewMokabPlace(place.id, 'admin-super', 'APPROVED');
    expect(reviewed.status).toBe('APPROVED');

    // اکنون در جست‌وجوی عمومی شهر مشهد دیده می‌شود
    const approved = await inventoryService.getApprovedPlaces('مشهد');
    expect(approved.length).toBe(1);
    expect(approved[0].id).toBe(place.id);
  });

  // آزمون‌های تکمیلی مدل‌های مالی
  it('اعتبارسنجی مدل‌های مالی: هزینه ثابت و تضمین به تومان', async () => {
    // مدل هزینه ثابت با مبلغ معتبر
    const feePlace = await inventoryService.registerMokabPlace({
      ...validMokabBase,
      financialModel: 'FIXED_FEE',
      feeAmountToman: 50000
    });
    expect(feePlace.feeAmountToman).toBe(50000);

    // مدل تضمین ثابت با مبلغ معتبر
    const depositPlace = await inventoryService.registerMokabPlace({
      ...validMokabBase,
      financialModel: 'FIXED_DEPOSIT',
      depositAmountToman: 200000
    });
    expect(depositPlace.depositAmountToman).toBe(200000);

    // خطا در صورت عدم تعیین مبلغ برای مدل پولی
    expect(inventoryService.registerMokabPlace({
      ...validMokabBase,
      financialModel: 'FIXED_FEE',
      feeAmountToman: 0
    })).rejects.toThrow('INVALID_FEE');
  });

  it('خطا در صورت کسری هر یک از مدارک ۴گانه پایه (DEC-0041)', async () => {
    // کسری عکس محل
    expect(inventoryService.registerMokabPlace({
      ...validMokabBase,
      placePhotoPath: ''
    })).rejects.toThrow('MISSING_DOCUMENT');

    // کسری مدرک مسئولیت
    expect(inventoryService.registerMokabPlace({
      ...validMokabBase,
      responsibilityDocumentPath: ' '
    })).rejects.toThrow('MISSING_DOCUMENT');
  });
});
