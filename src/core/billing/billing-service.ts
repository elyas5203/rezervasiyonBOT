/**
 * سرویس مالی، کارت‌به‌کارت و اعتبارسنجی رسید واریز (Billing Service)
 * پیاده‌سازی بر مبنای MASTER-06 و MASTER-20
 * منطبق با تصمیم‌های DEC-0011, DEC-0012, DEC-0013, DEC-0020, DEC-0021, DEC-0025, DEC-0032, DEC-0038
 */

import { CapacityService } from '../capacity/capacity-service.js';
import { ReservationService } from '../reservation/reservation-service.js';
import {
  BUSINESS_RULES,
  FinancialModel,
  ReceiptRecord,
  ReceiptVerificationStatus
} from '../types.js';

export class BillingService {
  private receipts: Map<string, ReceiptRecord> = new Map();
  private reservationService: ReservationService;
  private capacityService: CapacityService;

  constructor(reservationService: ReservationService, capacityService: CapacityService) {
    this.reservationService = reservationService;
    this.capacityService = capacityService;
  }

  /**
   * محاسبه مبلغ کل رزرو بر اساس مدل مالی موکب (DEC-0011, DEC-0013, DEC-0038)
   * قاعده ۱: هزینه ثبت و تضمین هم‌زمان غیرمجازند.
   * قاعده ۲: مبالغ مقطوع کل رزرو هستند و در شب/نفر/اتاق ضرب نمی‌شوند.
   */
  calculateTotalAmount(
    model: FinancialModel,
    feeAmountToman: number,
    depositAmountToman: number
  ): number {
    if (model === 'FREE') {
      return 0;
    }

    if (model === 'FIXED_FEE') {
      if (depositAmountToman > 0) {
        throw new Error('EXCLUSIVE_FINANCIAL_MODEL: هزینه ثبت رزرو و وجه تضمین نمی‌توانند هم‌زمان فعال باشند.');
      }
      if (feeAmountToman <= 0) {
        throw new Error('INVALID_AMOUNT: مبلغ هزینه ثبت رزرو باید بزرگتر از صفر باشد.');
      }
      return feeAmountToman;
    }

    if (model === 'FIXED_DEPOSIT') {
      if (feeAmountToman > 0) {
        throw new Error('EXCLUSIVE_FINANCIAL_MODEL: هزینه ثبت رزرو و وجه تضمین نمی‌توانند هم‌زمان فعال باشند.');
      }
      if (depositAmountToman <= 0) {
        throw new Error('INVALID_AMOUNT: مبلغ وجه تضمین باید بزرگتر از صفر باشد.');
      }
      return depositAmountToman;
    }

    throw new Error('UNKNOWN_FINANCIAL_MODEL: مدل مالی نامعتبر است.');
  }

  /**
   * ارسال تصویر رسید کارت‌به‌کارت توسط زائر (DEC-0012)
   * رزرو باید در وضعیت PENDING_PAYMENT_RECEIPT باشد.
   * پس از ارسال رسید، وضعیت رزرو به PENDING_RECEIPT_VERIFICATION تغییر می‌یابد.
   */
  async submitPaymentReceipt(
    reservationId: string,
    receiptImagePath: string,
    now: Date = new Date()
  ): Promise<ReceiptRecord> {
    const reservation = await this.reservationService.getReservationById(reservationId);
    if (!reservation) {
      throw new Error('RESERVATION_NOT_FOUND: رزرو یافت نشد.');
    }

    if (reservation.status !== 'PENDING_PAYMENT_RECEIPT') {
      throw new Error('INVALID_STATE: رزرو در وضعیت انتظار برای ارسال فیش نیست.');
    }

    if (!receiptImagePath || receiptImagePath.trim().length === 0) {
      throw new Error('MISSING_RECEIPT_IMAGE: بارگذاری تصویر فیش واریز الزامی است.');
    }

    const receiptId = `rcpt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const receipt: ReceiptRecord = {
      id: receiptId,
      reservationId,
      receiptImagePath: receiptImagePath.trim(),
      uploadedAt: now,
      verificationStatus: 'PENDING',
      verifiedAt: null,
      rejectionReason: null
    };

    this.receipts.set(receiptId, receipt);

    // مهلت جدید ۲۴ ساعته برای بررسی فیش توسط موکب‌دار (DEC-0025)
    const reviewExpiry = new Date(now.getTime() + BUSINESS_RULES.STEP_HOLD_VALIDITY_HOURS * 60 * 60 * 1000);
    await this.reservationService.updateReservationStatus(
      reservationId,
      'PENDING_RECEIPT_VERIFICATION',
      reviewExpiry,
      now
    );

    return receipt;
  }

  /**
   * بررسی و تطبیق واقعی فیش واریز توسط موکب‌دار با حساب بانکی‌اش (DEC-0012)
   */
  async reviewPaymentReceipt(
    receiptId: string,
    reviewerHostPersonId: string,
    decision: 'APPROVED' | 'REJECTED',
    rejectionReason?: string,
    now: Date = new Date()
  ): Promise<ReceiptRecord> {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) {
      throw new Error('RECEIPT_NOT_FOUND: رسید یافت نشد.');
    }

    if (receipt.verificationStatus !== 'PENDING') {
      throw new Error('RECEIPT_ALREADY_REVIEWED: این رسید قبلاً تعیین‌تکلیف شده است.');
    }

    const reservation = await this.reservationService.getReservationById(receipt.reservationId);
    if (!reservation) {
      throw new Error('RESERVATION_NOT_FOUND: رزرو مرتبط با این رسید یافت نشد.');
    }

    if (decision === 'APPROVED') {
      // موکب‌دار واریز واقعی به حسابش را تأیید کرد -> رزرو قطعی می‌شود
      receipt.verificationStatus = 'APPROVED';
      receipt.verifiedAt = now;
      receipt.rejectionReason = null;

      // قطعی‌سازی رزرو و هولد ظرفیت
      await this.reservationService.updateReservationStatus(reservation.id, 'CONFIRMED', null, now);
      if (reservation.holdId) {
        await this.capacityService.commitHold(reservation.holdId, reservation.id);
      }
    } else {
      // موکب‌دار فیش را رد کرد (مثلاً عدم واریز، فیش جعلی یا مبلغ نادرست)
      receipt.verificationStatus = 'REJECTED';
      receipt.verifiedAt = now;
      receipt.rejectionReason = rejectionReason ?? 'عدم تطبیق واریز با گردش حساب بانکی موکب';

      // بازگشت رزرو به وضعیت PENDING_PAYMENT_RECEIPT با مهلت ۲۴ ساعته اصلاح
      const newPaymentExpiry = new Date(now.getTime() + BUSINESS_RULES.STEP_HOLD_VALIDITY_HOURS * 60 * 60 * 1000);
      await this.reservationService.updateReservationStatus(
        reservation.id,
        'PENDING_PAYMENT_RECEIPT',
        newPaymentExpiry,
        now
      );
    }

    this.receipts.set(receiptId, receipt);
    return receipt;
  }

  /**
   * دریافت رسید با شناسه
   */
  async getReceiptById(receiptId: string): Promise<ReceiptRecord | undefined> {
    return this.receipts.get(receiptId);
  }

  /**
   * دریافت رسید بر اساس شناسه رزرو
   */
  async getReceiptByReservationId(reservationId: string): Promise<ReceiptRecord | undefined> {
    return Array.from(this.receipts.values()).find(r => r.reservationId === reservationId);
  }
}
