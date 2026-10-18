/**
 * سرویس اعلان‌های ایزوله و پیام‌رسانی امن (Notification Service)
 * پیاده‌سازی بر مبنای MASTER-07 و MASTER-21
 * منطبق با تصمیم‌های DEC-0003, DEC-0016
 */

import { ReservationRequest } from '../types.js';

export interface NotificationLog {
  recipientId: string;
  eventType: string;
  messageText: string;
  sentAt: Date;
  isDelivered: boolean;
  error?: string;
}

export class NotificationService {
  private logs: NotificationLog[] = [];
  public simulateFailure: boolean = false; // برای تست شکست شبکه

  /**
   * ساخت متن خلاصه امن برای اعلان وضعیت رزرو (عدم افشای شماره کارت یا گذرنامه)
   */
  buildSafeMessageText(reservation: ReservationRequest, eventType: string): string {
    switch (eventType) {
      case 'CONFIRMED':
        return `زائر گرامی، رزرو شما با کد پیگیری ${reservation.trackingCode} برای تاریخ ${reservation.checkInDate} قطعی شد.`;
      case 'CANCELLED':
        return `رزرو با کد پیگیری ${reservation.trackingCode} برای تاریخ ${reservation.checkInDate} لغو گردید.`;
      case 'NO_SHOW':
        return `عدم حضور مسافر برای رزرو با کد پیگیری ${reservation.trackingCode} ثبت شد.`;
      case 'COMPLETED':
        return `اقامت شما در موکب با کد پیگیری ${reservation.trackingCode} به پایان رسید. زیارت شما قبول حق.`;
      case 'PENDING_PAYMENT_RECEIPT':
        return `رزرو شما با کد پیگیری ${reservation.trackingCode} منتظر واریز و ارسال تصویر فیش کارت‌به‌کارت است (مهلت ۲۴ ساعت).`;
      default:
        return `وضعیت رزرو با کد پیگیری ${reservation.trackingCode} به روزرسانی شد: ${eventType}`;
    }
  }

  /**
   * ارسال اعلان به پیام‌رسان با تضمین عدم شکست تراکنش اصلی سامانه (DEC-0016)
   */
  async notifyReservationStatusChange(
    reservation: ReservationRequest,
    eventType: string,
    now: Date = new Date()
  ): Promise<boolean> {
    const text = this.buildSafeMessageText(reservation, eventType);

    // بررسی خط قرمز امنیتی: عدم افشای گذرنامه یا شماره کارت کامل
    if (text.includes('/uploads/passports/') || text.match(/\b\d{16}\b/)) {
      throw new Error('SECURITY_VIOLATION: اطلاعات حساس در متن اعلان شناسایی شد.');
    }

    try {
      if (this.simulateFailure) {
        throw new Error('NETWORK_TIMEOUT: درگاه پیام‌رسان پاسخ نمی‌دهد.');
      }

      this.logs.push({
        recipientId: reservation.personId,
        eventType,
        messageText: text,
        sentAt: now,
        isDelivered: true
      });

      return true;
    } catch (err: any) {
      // ثبت شکست در لاگ بدون پرتاب خطا به تراکنش بالادستی (DEC-0016)
      this.logs.push({
        recipientId: reservation.personId,
        eventType,
        messageText: text,
        sentAt: now,
        isDelivered: false,
        error: err.message
      });
      return false;
    }
  }

  /**
   * دریافت لاگ‌های اعلان ثبت‌شده
   */
  getNotificationLogs(): NotificationLog[] {
    return this.logs;
  }
}
