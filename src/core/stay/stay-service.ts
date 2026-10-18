/**
 * سرویس اقامت، لغو، عدم حضور و کارهای موعددار (Stay & Timed Jobs Service)
 * پیاده‌سازی بر مبنای MASTER-07 و MASTER-21
 * منطبق با تصمیم‌های DEC-0014, DEC-0016, DEC-0021, DEC-0025, DEC-0036, DEC-0037
 */

import { CapacityService } from '../capacity/capacity-service.js';
import { NotificationService } from '../notification/notification-service.js';
import { ReservationService } from '../reservation/reservation-service.js';
import { BUSINESS_RULES, ReservationRequest } from '../types.js';

export class StayService {
  private reservationService: ReservationService;
  private capacityService: CapacityService;
  private notificationService: NotificationService;

  constructor(
    reservationService: ReservationService,
    capacityService: CapacityService,
    notificationService: NotificationService
  ) {
    this.reservationService = reservationService;
    this.capacityService = capacityService;
    this.notificationService = notificationService;
  }

  /**
   * محاسبه زمان دقیق ورود برنامه‌ریزی‌شده بر اساس تاریخ ورود و ساعت موکب
   */
  private getScheduledCheckInTime(checkInDate: string, checkInHour: number): Date {
    const hourStr = String(checkInHour).padStart(2, '0');
    return new Date(`${checkInDate}T${hourStr}:00:00Z`);
  }

  /**
   * ثبت ورود حضوری مسافر با کد رهگیری (Check-in)
   */
  async checkIn(
    reservationId: string,
    hostPersonId: string,
    now: Date = new Date()
  ): Promise<ReservationRequest> {
    const reservation = await this.reservationService.getReservationById(reservationId);
    if (!reservation) {
      throw new Error('RESERVATION_NOT_FOUND: رزرو یافت نشد.');
    }

    if (reservation.status !== 'CONFIRMED') {
      throw new Error('INVALID_STATE: فقط برای رزروهای قطعی می‌توان ورود ثبت کرد.');
    }

    // ارسال اعلان ورود
    await this.notificationService.notifyReservationStatusChange(reservation, 'CHECKED_IN', now);
    return reservation;
  }

  /**
   * ثبت خروج و پایان اقامت (Check-out)
   * وضعیت به COMPLETED تغییر می‌یابد و تسویه تضمین بیرون سامانه انجام می‌گیرد (DEC-0021).
   */
  async checkOut(
    reservationId: string,
    hostPersonId: string,
    now: Date = new Date()
  ): Promise<ReservationRequest> {
    const reservation = await this.reservationService.getReservationById(reservationId);
    if (!reservation) {
      throw new Error('RESERVATION_NOT_FOUND: رزرو یافت نشد.');
    }

    if (reservation.status !== 'CONFIRMED') {
      throw new Error('INVALID_STATE: رزرو در وضعیت قطعی قرار ندارد.');
    }

    const updated = await this.reservationService.updateReservationStatus(
      reservationId,
      'COMPLETED',
      null,
      now
    );

    // ارسال اعلان پایان اقامت
    await this.notificationService.notifyReservationStatusChange(updated, 'COMPLETED', now);
    return updated;
  }

  /**
   * لغو اقامت توسط مسافر (حداکثر تا ۲۴ ساعت پیش از ساعت ورود DEC-0025)
   */
  async cancelByTraveler(
    reservationId: string,
    personId: string,
    checkInHour: number = 14,
    now: Date = new Date()
  ): Promise<ReservationRequest> {
    const reservation = await this.reservationService.getReservationById(reservationId);
    if (!reservation) {
      throw new Error('RESERVATION_NOT_FOUND: رزرو یافت نشد.');
    }

    if (reservation.personId !== personId) {
      throw new Error('FORBIDDEN: شما مجاز به لغو این رزرو نیستید.');
    }

    if (reservation.status !== 'CONFIRMED' && !reservation.status.startsWith('PENDING')) {
      throw new Error('INVALID_STATE: این رزرو در وضعیتی نیست که قابل لغو باشد.');
    }

    // کنترل مرز ۲۴ ساعته تا ساعت ورود (DEC-0025)
    const scheduledTime = this.getScheduledCheckInTime(reservation.checkInDate, checkInHour);
    const msUntilCheckIn = scheduledTime.getTime() - now.getTime();
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;

    if (msUntilCheckIn < twentyFourHoursMs) {
      throw new Error('CANCELLATION_DEADLINE_PASSED: لغو سیستمی فقط تا ۲۴ ساعت پیش از موعد ورود امکان‌پذیر است.');
    }

    // تغییر وضعیت به CANCELLED
    const cancelled = await this.reservationService.updateReservationStatus(
      reservationId,
      'CANCELLED',
      null,
      now
    );

    // آزادسازی فوری هولد ظرفیت در صورت وجود
    if (reservation.holdId) {
      await this.capacityService.releaseHold(reservation.holdId, 'لغو توسط مسافر');
    }

    // ارسال اعلان لغو
    await this.notificationService.notifyReservationStatusChange(cancelled, 'CANCELLED', now);
    return cancelled;
  }

  /**
   * ثبت عدم حضور مسافر (No-Show) پس از گذشت ۲۴ ساعت از ساعت ورود (DEC-0025)
   */
  async markNoShow(
    reservationId: string,
    hostPersonId: string,
    checkInHour: number = 14,
    now: Date = new Date()
  ): Promise<ReservationRequest> {
    const reservation = await this.reservationService.getReservationById(reservationId);
    if (!reservation) {
      throw new Error('RESERVATION_NOT_FOUND: رزرو یافت نشد.');
    }

    if (reservation.status !== 'CONFIRMED') {
      throw new Error('INVALID_STATE: فقط برای رزروهای قطعی می‌توان عدم حضور ثبت کرد.');
    }

    const scheduledTime = this.getScheduledCheckInTime(reservation.checkInDate, checkInHour);
    const msSinceCheckIn = now.getTime() - scheduledTime.getTime();
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;

    if (msSinceCheckIn < twentyFourHoursMs) {
      throw new Error('NO_SHOW_PREMATURE: ثبت عدم حضور فقط پس از گذشت ۲۴ ساعت از ساعت ورود امکان‌پذیر است.');
    }

    const noShowRes = await this.reservationService.updateReservationStatus(
      reservationId,
      'NO_SHOW',
      null,
      now
    );

    // آزادسازی ظرفیت باقی‌مانده
    if (reservation.holdId) {
      await this.capacityService.releaseHold(reservation.holdId, 'عدم حضور مسافر');
    }

    // ارسال اعلان عدم حضور
    await this.notificationService.notifyReservationStatusChange(noShowRes, 'NO_SHOW', now);
    return noShowRes;
  }

  /**
   * جاب دوره‌ای پاکسازی تصویر گذرنامه زائران خارجی پس از ۳۰ روز از اتمام پرونده (DEC-0036, DEC-0037)
   */
  async cleanupExpiredPassports(
    reservations: ReservationRequest[],
    now: Date = new Date()
  ): Promise<number> {
    const thirtyDaysMs = BUSINESS_RULES.PASSPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let deletedCount = 0;

    for (const res of reservations) {
      // فقط زائران خارجی دارای تصویر گذرنامه که پرونده آن‌ها بسته شده است
      const isClosedState = ['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(res.status);
      if (res.isForeignPilgrim && res.passportImagePath && isClosedState) {
        const timeSinceClose = now.getTime() - res.updatedAt.getTime();
        if (timeSinceClose >= thirtyDaysMs) {
          res.passportImagePath = null;
          res.passportDeletedAt = now;
          deletedCount++;
        }
      }
    }

    return deletedCount;
  }
}
