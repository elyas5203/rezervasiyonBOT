/**
 * سرویس چرخه حیات درخواست و چهار مسیر رزرو زائر (Reservation Lifecycle)
 * پیاده‌سازی بر مبنای MASTER-05 و MASTER-19
 * منطبق با تصمیم‌های DEC-0008, DEC-0010, DEC-0011, DEC-0014, DEC-0015, DEC-0024, DEC-0025, DEC-0027, DEC-0032, DEC-0033/34, DEC-0035, DEC-0043
 */

import { CapacityService } from '../capacity/capacity-service.js';
import {
  BUSINESS_RULES,
  MokabPlace,
  ReservationRequest,
  ReservationStatus,
  Space
} from '../types.js';

export interface CreateReservationDTO {
  personId: string;
  contactPhone: string;
  place: MokabPlace;
  space: Space;
  checkInDate: string;  // YYYY-MM-DD
  checkOutDate: string; // YYYY-MM-DD
  maleCount: number;
  femaleCount: number;
  childCount: number;
  isForeignPilgrim: boolean;
  passportImagePath?: string | null;
  now?: Date;
}

export class ReservationService {
  private reservations: Map<string, ReservationRequest> = new Map();
  private capacityService: CapacityService;

  constructor(capacityService: CapacityService) {
    this.capacityService = capacityService;
  }

  /**
   * تولید کد رهگیری یکتا و خوانا (۶ کاراکتر)
   */
  private generateTrackingCode(): string {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = 'RZ-';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  /**
   * ثبت درخواست رزرو با پیمایش ۴ مسیر مصوب و مسیر زائر خارجی (MASTER-05, MASTER-19)
   */
  async createReservation(dto: CreateReservationDTO): Promise<ReservationRequest> {
    const now = dto.now ?? new Date();

    // ۱. اعتبارسنجی شماره تماس زائر (DEC-0043)
    if (!dto.contactPhone || dto.contactPhone.trim().length === 0) {
      throw new Error('MISSING_PHONE_NUMBER: شماره تلفن تماس هنگام رزرو الزامی است.');
    }

    // ۲. اعتبارسنجی شمارش مسافران (شمارش کودکان بدون استثنا DEC-0027)
    const totalCount = dto.maleCount + dto.femaleCount + dto.childCount;
    if (totalCount <= 0) {
      throw new Error('INVALID_PILGRIM_COUNT: تعداد کل مسافران باید حداقل ۱ نفر باشد.');
    }

    // اعتبارسنجی جنسیت سالن عمومی (DEC-0007)
    if (dto.space.spaceType === 'PUBLIC_HALL') {
      if (dto.space.genderGroup === 'MEN' && dto.femaleCount > 0) {
        throw new Error('GENDER_MISMATCH: سالن آقایان نمی‌تواند زائر خانم بپذیرد.');
      }
      if (dto.space.genderGroup === 'WOMEN' && dto.maleCount > 0) {
        throw new Error('GENDER_MISMATCH: سالن بانوان نمی‌تواند زائر آقا بپذیرد.');
      }
    } else if (dto.space.spaceType === 'PRIVATE_ROOM') {
      // اتاق خصوصی: کل نفرات با احتساب کودکان نباید بیش از ظرفیت اسمی باشد
      if (totalCount > dto.space.nominalCapacity) {
        throw new Error('CAPACITY_EXCEEDED: تعداد نفرات بیش از ظرفیت اسمی اتاق است.');
      }
    }

    // ۳. اعتبارسنجی مرز ۷ روز پیش از ورود (Cutoff Gate طبق DEC-0033, DEC-0034)
    const isAllowedCutoff = this.capacityService.isDateAllowedByCutoff(
      dto.checkInDate,
      now,
      dto.place.city
    );
    if (!isAllowedCutoff) {
      throw new Error('CUTOFF_EXCEEDED: ثبت درخواست جدید کمتر از ۷ روز مانده به ورود امکان‌پذیر نیست.');
    }

    // ۴. استخراج شب‌های اقامت و بررسی سقف مدت اقامت موکب (DEC-0009)
    const stayNights = this.capacityService.calculateStayNights(dto.checkInDate, dto.checkOutDate);
    const isDurationAllowed = await this.capacityService.validateStayDuration(dto.place.id, stayNights);
    if (!isDurationAllowed) {
      throw new Error('MAX_STAY_EXCEEDED: مدت اقامت درخواستی بیش از سقف مجاز این موکب است.');
    }

    // ۵. ایجاد نگه‌داشت موقت ۲۴ ساعته ظرفیت (Hold) برای جلوگیری از Overbooking (DEC-0025, DEC-0035)
    const holdPersonCount = dto.space.spaceType === 'PUBLIC_HALL' ? totalCount : dto.space.nominalCapacity;
    const holdGender = dto.space.spaceType === 'PUBLIC_HALL' ? dto.space.genderGroup : 'ALL';

    const hold = await this.capacityService.createCapacityHold(
      dto.space,
      {
        placeId: dto.place.id,
        spaceId: dto.space.id,
        stayNights,
        personCount: holdPersonCount,
        genderGroup: holdGender
      },
      now
    );

    // ۶. تعیین شناسه و کد رهگیری
    const reservationId = `res-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const trackingCode = this.generateTrackingCode();
    const holdExpiresAt = new Date(now.getTime() + BUSINESS_RULES.STEP_HOLD_VALIDITY_HOURS * 60 * 60 * 1000);

    let initialStatus: ReservationStatus;

    // ۷. انشعاب مسیرها بر اساس نوع زائر و تنظیمات موکب (MASTER-05)
    if (dto.isForeignPilgrim) {
      // مسیر زائر خارجی: بدون پرداخت در سامانه، الزام تصویر گذرنامه، ارجاع مستقیم به موکب‌دار (DEC-0032, DEC-0036)
      if (!dto.passportImagePath || dto.passportImagePath.trim().length === 0) {
        // آزادسازی هولد قبل از پرتاب خطا
        await this.capacityService.releaseHold(hold.id, 'نقص مدرک گذرنامه');
        throw new Error('MISSING_PASSPORT: برای زائر خارجی بارگذاری تصویر گذرنامه الزامی است.');
      }
      initialStatus = 'PENDING_HOST_APPROVAL';
    } else {
      // زائر عادی: پیمایش چهار مسیر استاندارد
      const isInstant = dto.place.approvalMode === 'INSTANT';
      const isFree = dto.place.financialModel === 'FREE';

      if (isInstant && isFree) {
        // مسیر ۱: تأیید فوری و رایگان -> قطعی آنی
        initialStatus = 'CONFIRMED';
        await this.capacityService.commitHold(hold.id, reservationId);
      } else if (!isInstant && isFree) {
        // مسیر ۲: تأیید دستی و رایگان -> انتظار قبول موکب‌دار
        initialStatus = 'PENDING_HOST_APPROVAL';
      } else if (isInstant && !isFree) {
        // مسیر ۳: تأیید فوری و پولی -> انتقال مستقیم به انتظار واریز فیش
        initialStatus = 'PENDING_PAYMENT_RECEIPT';
      } else {
        // مسیر ۴: تأیید دستی و پولی -> ابتدا انتظار قبول موکب‌دار (بدون درخواست پول)
        initialStatus = 'PENDING_HOST_APPROVAL';
      }
    }

    const reservation: ReservationRequest = {
      id: reservationId,
      trackingCode,
      personId: dto.personId,
      contactPhone: dto.contactPhone.trim(),
      placeId: dto.place.id,
      spaceId: dto.space.id,
      checkInDate: dto.checkInDate,
      checkOutDate: dto.checkOutDate,
      maleCount: dto.maleCount,
      femaleCount: dto.femaleCount,
      childCount: dto.childCount,
      totalCount,
      status: initialStatus,
      holdId: hold.id,
      holdExpiresAt: initialStatus === 'CONFIRMED' ? null : holdExpiresAt,
      cancellationRulesSnapshot: dto.place.cancellationRules, // فریز قانون لغو در زمان رزرو (DEC-0014)
      isForeignPilgrim: dto.isForeignPilgrim,
      passportImagePath: dto.passportImagePath ?? null,
      passportDeletedAt: null,
      createdAt: now,
      updatedAt: now
    };

    this.reservations.set(reservationId, reservation);
    return reservation;
  }

  /**
   * بررسی و تصمیم موکب‌دار درباره درخواست رزرو در انتظار (DEC-0010, DEC-0032)
   */
  async hostReviewReservation(
    reservationId: string,
    hostPersonId: string,
    decision: 'ACCEPT' | 'REJECT',
    place: MokabPlace,
    now: Date = new Date()
  ): Promise<ReservationRequest> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new Error('RESERVATION_NOT_FOUND: رزرو یافت نشد.');
    }

    if (reservation.status !== 'PENDING_HOST_APPROVAL') {
      throw new Error('INVALID_STATE: این رزرو در انتظار تأیید موکب‌دار نیست.');
    }

    if (decision === 'REJECT') {
      // رد توسط موکب‌دار -> وضعیت لغو و آزادسازی فوری هولد
      reservation.status = 'CANCELLED';
      reservation.updatedAt = now;
      if (reservation.holdId) {
        await this.capacityService.releaseHold(reservation.holdId, 'رد توسط موکب‌دار');
      }
    } else {
      // قبول توسط موکب‌دار
      if (reservation.isForeignPilgrim || place.financialModel === 'FREE') {
        // زائر خارجی یا موکب رایگان -> مستقیماً قطعی می‌شود
        reservation.status = 'CONFIRMED';
        reservation.holdExpiresAt = null;
        reservation.updatedAt = now;
        if (reservation.holdId) {
          await this.capacityService.commitHold(reservation.holdId, reservation.id);
        }
      } else {
        // موکب پولی -> ورود به مهلت ۲۴ ساعته پرداخت و واریز فیش (مسیر ۴)
        reservation.status = 'PENDING_PAYMENT_RECEIPT';
        reservation.holdExpiresAt = new Date(now.getTime() + BUSINESS_RULES.STEP_HOLD_VALIDITY_HOURS * 60 * 60 * 1000);
        reservation.updatedAt = now;
      }
    }

    this.reservations.set(reservationId, reservation);
    return reservation;
  }

  /**
   * دریافت رزرو با کد رهگیری
   */
  async getReservationByTrackingCode(trackingCode: string): Promise<ReservationRequest | undefined> {
    return Array.from(this.reservations.values()).find(r => r.trackingCode === trackingCode);
  }

  /**
   * دریافت تمامی رزروهای یک زائر (پشتیبانی از رزروهای هم‌پوشان و چندگانه DEC-0024)
   */
  async getReservationsByPerson(personId: string): Promise<ReservationRequest[]> {
    return Array.from(this.reservations.values()).filter(r => r.personId === personId);
  }

  /**
   * به‌روزرسانی وضعیت رزرو توسط سرویس‌های مجاز (مانند سرویس مالی و تسویه)
   */
  async updateReservationStatus(
    reservationId: string,
    newStatus: ReservationStatus,
    newHoldExpiry?: Date | null,
    now: Date = new Date()
  ): Promise<ReservationRequest> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new Error('RESERVATION_NOT_FOUND: رزرو یافت نشد.');
    }

    reservation.status = newStatus;
    if (newHoldExpiry !== undefined) {
      reservation.holdExpiresAt = newHoldExpiry;
    }
    reservation.updatedAt = now;
    this.reservations.set(reservationId, reservation);
    return reservation;
  }

  /**
   * دریافت تمامی رزروهای یک موکب (جهت بررسی وضعیت و تعطیلی اضطراری)
   */
  async getReservationsByPlaceId(placeId: string): Promise<ReservationRequest[]> {
    return Array.from(this.reservations.values()).filter(r => r.placeId === placeId);
  }

  /**
   * دریافت رزرو بر اساس شناسه
   */
  async getReservationById(reservationId: string): Promise<ReservationRequest | undefined> {
    return this.reservations.get(reservationId);
  }

  /**
   * دریافت کلیه رزروها (جهت آمار و داشبورد مدیریت)
   */
  async getAllReservations(): Promise<ReservationRequest[]> {
    return Array.from(this.reservations.values());
  }
}

