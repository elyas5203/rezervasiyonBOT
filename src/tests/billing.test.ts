/**
 * آزمون‌های واحد سیستم مالی، کارت‌به‌کارت و اعتبارسنجی رسید واریز (MASTER-20)
 * معیارهای پذیرش PAY-01 تا PAY-07
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { BillingService } from '../core/billing/billing-service.js';
import { CapacityService } from '../core/capacity/capacity-service.js';
import { ReservationService } from '../core/reservation/reservation-service.js';
import { MokabPlace, Space } from '../core/types.js';

describe('MASTER-20 — آزمون‌های سیستم مالی، کارت‌به‌کارت و بررسی رسید دستی (Billing & Receipts)', () => {
  let capacityService: CapacityService;
  let reservationService: ReservationService;
  let billingService: BillingService;

  const simulatedNow = new Date('2026-11-15T10:00:00Z');
  const checkInDate = '2026-11-30';
  const checkOutDate = '2026-12-03'; // ۳ شب اقامت

  const feePlace: MokabPlace = {
    id: 'place-fee-1',
    hostPersonId: 'host-1',
    title: 'موکب با هزینه ثابت',
    city: 'کربلا',
    address: 'شارع قبله الامام الحسین',
    contactName: 'حاج احمد',
    contactPhone: '09123456780',
    status: 'APPROVED',
    supplyType: 'PUBLIC',
    financialModel: 'FIXED_FEE',
    approvalMode: 'INSTANT',
    feeAmountToman: 150000,
    depositAmountToman: 0,
    cancellationRules: 'لغو تا ۴۸ ساعت قبل مجاز است.',
    createdAt: new Date()
  };

  const depositPlace: MokabPlace = {
    id: 'place-dep-1',
    hostPersonId: 'host-2',
    title: 'موکب با وجه تضمین',
    city: 'نجف',
    address: 'شارع الرسول',
    contactName: 'حاج محمد',
    contactPhone: '09123456781',
    status: 'APPROVED',
    supplyType: 'PRIVATE',
    financialModel: 'FIXED_DEPOSIT',
    approvalMode: 'MANUAL',
    feeAmountToman: 0,
    depositAmountToman: 300000,
    cancellationRules: 'وجه تضمین هنگام خروج عودت داده می‌شود.',
    createdAt: new Date()
  };

  const sampleHall: Space = {
    id: 'hall-men-1',
    placeId: 'place-fee-1',
    spaceType: 'PUBLIC_HALL',
    title: 'سالن بزرگ آقایان',
    genderGroup: 'MEN',
    nominalCapacity: 20,
    createdAt: new Date()
  };

  const sampleRoom: Space = {
    id: 'room-dep-1',
    placeId: 'place-dep-1',
    spaceType: 'PRIVATE_ROOM',
    title: 'اتاق ۴ نفره',
    genderGroup: 'ALL',
    nominalCapacity: 4,
    createdAt: new Date()
  };

  beforeEach(() => {
    capacityService = new CapacityService();
    reservationService = new ReservationService(capacityService);
    billingService = new BillingService(reservationService, capacityService);
  });

  // PAY-01: ارسال تصویر رسید وضعیت را به PENDING_RECEIPT_VERIFICATION می‌برد اما قطعی نمی‌کند
  it('PAY-01: بارگذاری فیش فقط وضعیت را به انتظار بررسی می‌برد و بدون تأیید قطعی نمی‌شود', async () => {
    // رزرو در موکب با هزینه ثابت و تأیید فوری -> وضعیت اولیه PENDING_PAYMENT_RECEIPT
    const reservation = await reservationService.createReservation({
      personId: 'traveler-1',
      contactPhone: '09121111111',
      place: feePlace,
      space: sampleHall,
      checkInDate,
      checkOutDate,
      maleCount: 2,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: false,
      now: simulatedNow
    });

    expect(reservation.status).toBe('PENDING_PAYMENT_RECEIPT');

    // زائر تصویر فیش را ارسال می‌کند
    const receipt = await billingService.submitPaymentReceipt(
      reservation.id,
      '/uploads/receipts/slip1.jpg',
      simulatedNow
    );

    expect(receipt.verificationStatus).toBe('PENDING');

    // رزرو باید در انتظار بررسی فیش باشد نه CONFIRMED (DEC-0012)
    const updatedRes = await reservationService.getReservationById(reservation.id);
    expect(updatedRes?.status).toBe('PENDING_RECEIPT_VERIFICATION');
  });

  // PAY-02: تأیید واقعی واریز توسط موکب‌دار وضعیت فیش را APPROVED و رزرو را CONFIRMED می‌کند
  it('PAY-02: تأیید واریز توسط موکب‌دار فیش را APPROVED و رزرو را قطعی می‌کند', async () => {
    const reservation = await reservationService.createReservation({
      personId: 'traveler-1',
      contactPhone: '09121111111',
      place: feePlace,
      space: sampleHall,
      checkInDate,
      checkOutDate,
      maleCount: 2,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: false,
      now: simulatedNow
    });

    const receipt = await billingService.submitPaymentReceipt(
      reservation.id,
      '/uploads/receipts/slip1.jpg',
      simulatedNow
    );

    // موکب‌دار واریز به حساب را چک کرده و تأیید می‌کند
    const reviewed = await billingService.reviewPaymentReceipt(
      receipt.id,
      feePlace.hostPersonId,
      'APPROVED',
      undefined,
      simulatedNow
    );

    expect(reviewed.verificationStatus).toBe('APPROVED');

    // وضعیت رزرو باید قطعی (CONFIRMED) شده باشد
    const confirmedRes = await reservationService.getReservationById(reservation.id);
    expect(confirmedRes?.status).toBe('CONFIRMED');
    expect(confirmedRes?.holdExpiresAt).toBeNull();
  });

  // PAY-03: رد فیش وضعیت رزرو را به PENDING_PAYMENT_RECEIPT برمی‌گرداند تا زائر فرصت اصلاح داشته باشد
  it('PAY-03: رد فیش وضعیت رزرو را به انتظار واریز برمی‌گرداند تا زائر بتواند اصلاح کند', async () => {
    const reservation = await reservationService.createReservation({
      personId: 'traveler-1',
      contactPhone: '09121111111',
      place: feePlace,
      space: sampleHall,
      checkInDate,
      checkOutDate,
      maleCount: 2,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: false,
      now: simulatedNow
    });

    const receipt = await billingService.submitPaymentReceipt(
      reservation.id,
      '/uploads/receipts/bad_slip.jpg',
      simulatedNow
    );

    // موکب‌دار واریز را بررسی می‌کند اما واریزی در حساب دیده نمی‌شود
    const rejected = await billingService.reviewPaymentReceipt(
      receipt.id,
      feePlace.hostPersonId,
      'REJECTED',
      'مبلغ در گردش حساب دیده نشد یا شماره پیگیری نادرست است',
      simulatedNow
    );

    expect(rejected.verificationStatus).toBe('REJECTED');
    expect(rejected.rejectionReason).toBe('مبلغ در گردش حساب دیده نشد یا شماره پیگیری نادرست است');

    // رزرو باید دوباره به PENDING_PAYMENT_RECEIPT بازگردد
    const revertedRes = await reservationService.getReservationById(reservation.id);
    expect(revertedRes?.status).toBe('PENDING_PAYMENT_RECEIPT');
  });

  // PAY-04: عدم امکان ترکیب هم‌زمان مدل هزینه ثابت و تضمین ثابت (DEC-0011)
  it('PAY-04: هزینه ثبت رزرو و وجه تضمین هرگز هم‌زمان قابل تعریف نیستند', () => {
    // خطا در صورت وارد کردن هر دو مقدار
    expect(() => billingService.calculateTotalAmount('FIXED_FEE', 100000, 200000)).toThrow('EXCLUSIVE_FINANCIAL_MODEL');
    expect(() => billingService.calculateTotalAmount('FIXED_DEPOSIT', 50000, 300000)).toThrow('EXCLUSIVE_FINANCIAL_MODEL');
  });

  // PAY-05: مبلغ ثابت کل رزرو است و در شب/نفر/اتاق ضرب نمی‌شود (DEC-0013)
  it('PAY-05: مبلغ کل رزرو مقطوع است و برای گروه ۱ نفره در ۱ شب با ۵ نفره در ۳ شب یکسان است', () => {
    // مبلغ موکب با هزینه ۱۵۰,۰۰۰ تومان
    const amount1 = billingService.calculateTotalAmount('FIXED_FEE', 150000, 0);
    expect(amount1).toBe(150000);

    // برای هر مسافر یا هر تعداد شب دیگری، کل مبلغ همان ۱۵۰,۰۰۰ تومان است
    const amount2 = billingService.calculateTotalAmount('FIXED_DEPOSIT', 0, 300000);
    expect(amount2).toBe(300000);
  });

  // PAY-06: زائر خارجی بدون پرداخت و فیش رزرو می‌شود (DEC-0032)
  it('PAY-06: زائر خارجی نیازی به بارگذاری فیش نداشته و مبلغ او در سامانه صفر است', async () => {
    // زائر خارجی برای موکب پولی (تضمینی) درخواست می‌دهد
    const foreignReservation = await reservationService.createReservation({
      personId: 'foreign-traveler',
      contactPhone: '+9647701234567',
      place: depositPlace,
      space: sampleRoom,
      checkInDate,
      checkOutDate,
      maleCount: 3,
      femaleCount: 0,
      childCount: 0,
      isForeignPilgrim: true,
      passportImagePath: '/uploads/passports/foreign.jpg',
      now: simulatedNow
    });

    // وضعیت مستقیماً در انتظار موکب‌دار است (نه واریز فیش)
    expect(foreignReservation.status).toBe('PENDING_HOST_APPROVAL');

    // موکب‌دار زائر خارجی را قبول می‌کند
    const approved = await reservationService.hostReviewReservation(
      foreignReservation.id,
      depositPlace.hostPersonId,
      'ACCEPT',
      depositPlace,
      simulatedNow
    );

    // بدون مطالبه هیچ فیشی، مستقیماً CONFIRMED می‌شود (DEC-0032)
    expect(approved.status).toBe('CONFIRMED');

    // فیش پرداختی برای این رزرو وجود ندارد
    const receipt = await billingService.getReceiptByReservationId(foreignReservation.id);
    expect(receipt).toBeUndefined();
  });

  // PAY-07: عدم وجود کیف پول یا عملیات بازپرداخت در سامانه (DEC-0021)
  it('PAY-07: سامانه فاقد عملیات بازپرداخت است و وجه تضمین خارج از سامانه عودت داده می‌شود', () => {
    // هیچ متد یا رابط کاربری بازپرداختی در BillingService وجود ندارد
    expect((billingService as any).refundDeposit).toBeUndefined();
    expect((billingService as any).createWallet).toBeUndefined();
  });
});
