/**
 * سرویس تقویم، مدت، کنترل ظرفیت و نگه‌داشت موقت (Capacity Engine)
 * پیاده‌سازی بر مبنای MASTER-04 و MASTER-18
 * منطبق با تصمیم‌های DEC-0005, DEC-0006, DEC-0007, DEC-0009, DEC-0025, DEC-0027, DEC-0033, DEC-0034, DEC-0035
 */

import {
  BUSINESS_RULES,
  CapacityHold,
  CapacityHoldStatus,
  GenderGroup,
  PlaceOperatingRules,
  Space
} from '../types.js';

export interface CreateHoldDTO {
  placeId: string;
  spaceId: string;
  stayNights: string[];
  personCount: number;
  genderGroup: GenderGroup;
  reservationId?: string;
}

export interface CapacityCheckResult {
  available: boolean;
  requestedNights: string[];
  freeCapacityPerNight: Record<string, number>;
  nominalCapacity: number;
  reason?: string;
}

export class CapacityService {
  private operatingRules: Map<string, PlaceOperatingRules> = new Map();
  private holds: Map<string, CapacityHold> = new Map();
  private confirmedBookings: Map<string, { spaceId: string; night: string; personCount: number }> = new Map();

  /**
   * تنظیم و ذخیره قوانین بهره‌برداری موکب (DEC-0009)
   */
  async setPlaceOperatingRules(rules: PlaceOperatingRules): Promise<void> {
    if (rules.maxStayNights <= 0) {
      throw new Error('INVALID_MAX_STAY: سقف مدت اقامت باید حداقل ۱ شب باشد.');
    }
    if (rules.checkInHour < 0 || rules.checkInHour > 23 || rules.checkOutHour < 0 || rules.checkOutHour > 23) {
      throw new Error('INVALID_HOURS: ساعت ورود و خروج باید بین ۰ تا ۲۳ باشد.');
    }
    this.operatingRules.set(rules.placeId, rules);
  }

  /**
   * دریافت قوانین بهره‌برداری موکب
   */
  async getPlaceOperatingRules(placeId: string): Promise<PlaceOperatingRules | undefined> {
    return this.operatingRules.get(placeId);
  }

  /**
   * استخراج لیست دقیق شب‌های اقامت بین تاریخ ورود و خروج
   * قاعده: شب خروج اشغال نمی‌شود (ورود ۱۰، خروج ۱۲ = ۲ شب: ۱۰ و ۱۱)
   */
  calculateStayNights(checkInDate: string, checkOutDate: string): string[] {
    const start = new Date(checkInDate + 'T00:00:00Z');
    const end = new Date(checkOutDate + 'T00:00:00Z');

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error('INVALID_DATE_FORMAT: تاریخ‌ها باید در قالب YYYY-MM-DD باشند.');
    }

    const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) {
      throw new Error('INVALID_DATE_RANGE: تاریخ خروج باید بعد از تاریخ ورود باشد.');
    }

    const nights: string[] = [];
    const current = new Date(start);
    while (current < end) {
      const yyyy = current.getUTCFullYear();
      const mm = String(current.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(current.getUTCDate()).padStart(2, '0');
      nights.push(`${yyyy}-${mm}-${dd}`);
      current.setUTCDate(current.getUTCDate() + 1);
    }

    return nights;
  }

  /**
   * کنترل مرز ۷ روز پیش از ورود به وقت محلی شهر مقصد (DEC-0033, DEC-0034)
   * آخرین روز درخواست تا پایان روز هفتم پیش از ورود است.
   * مثلا برای ورود ۲۰ آبان (2026-11-10)، ثبت در روز ۱۳ آبان مجاز و در ۱۴ آبان غیرمجاز است.
   */
  isDateAllowedByCutoff(checkInDate: string, requestTimestamp: Date, city: string): boolean {
    const checkIn = new Date(checkInDate + 'T00:00:00Z');
    if (isNaN(checkIn.getTime())) {
      throw new Error('INVALID_DATE_FORMAT: تاریخ ورود نامعتبر است.');
    }

    // آخرین روز مجاز = ۷ روز تقویمی قبل از تاریخ ورود
    const cutoffDate = new Date(checkIn);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - BUSINESS_RULES.CUTOFF_DAYS_BEFORE_CHECKIN);

    // ساعت محلی: شهرهای عراق (کربلا، نجف، سامرا، کاظمین) UTC+3 و شهرهای ایران UTC+3:30
    const isIraq = ['نجف', 'کربلا', 'سامرا', 'کاظمین', 'بغداد'].includes(city);
    const timezoneOffsetHours = isIraq ? 3.0 : 3.5;

    // استخراج تاریخ محلی زمان درخواست
    const localReqTime = new Date(requestTimestamp.getTime() + timezoneOffsetHours * 60 * 60 * 1000);
    const reqYear = localReqTime.getUTCFullYear();
    const reqMonth = localReqTime.getUTCMonth();
    const reqDay = localReqTime.getUTCDate();
    const localReqDateOnly = new Date(Date.UTC(reqYear, reqMonth, reqDay));

    // استخراج تاریخ تقویمی بدون ساعت مرز ۷ روزه
    const cutoffDateOnly = new Date(Date.UTC(
      cutoffDate.getUTCFullYear(),
      cutoffDate.getUTCMonth(),
      cutoffDate.getUTCDate()
    ));

    // اگر تاریخ تقویمی درخواست بعد از مرز ۷ روزه باشد، غیرمجاز است
    return localReqDateOnly.getTime() <= cutoffDateOnly.getTime();
  }

  /**
   * اعتبارسنجی انطباق مدت اقامت با سقف اعلامی موکب (DEC-0009)
   */
  async validateStayDuration(placeId: string, stayNights: string[]): Promise<boolean> {
    const rules = this.operatingRules.get(placeId);
    if (!rules) {
      return true; // در صورت عدم ثبت سقف اختصاصی، پیش‌فرضی مسدود نمی‌شود
    }
    return stayNights.length <= rules.maxStayNights;
  }

  /**
   * استعلام ظرفیت آزاد سالن عمومی برای تمام شب‌های اقامت (DEC-0007, DEC-0035)
   */
  async checkPublicHallAvailability(
    space: Space,
    stayNights: string[],
    requestedCount: number,
    now: Date = new Date()
  ): Promise<CapacityCheckResult> {
    if (space.spaceType !== 'PUBLIC_HALL') {
      throw new Error('INVALID_SPACE_TYPE: فضا باید از نوع سالن عمومی باشد.');
    }

    const freeCapacityPerNight: Record<string, number> = {};
    let isAvailable = true;

    for (const night of stayNights) {
      // ظرفیت اسمی
      const nominal = space.nominalCapacity;

      // اشغال‌شده توسط رزروهای قطعی
      const confirmedOccupied = Array.from(this.confirmedBookings.values())
        .filter(b => b.spaceId === space.id && b.night === night)
        .reduce((sum, b) => sum + b.personCount, 0);

      // اشغال‌شده توسط هولدهای معتبر و فعال
      const holdOccupied = Array.from(this.holds.values())
        .filter(h =>
          h.spaceId === space.id &&
          h.status === 'ACTIVE' &&
          h.expiresAt > now &&
          h.stayNights.includes(night)
        )
        .reduce((sum, h) => sum + h.personCount, 0);

      const free = nominal - confirmedOccupied - holdOccupied;
      freeCapacityPerNight[night] = Math.max(0, free);

      if (free < requestedCount) {
        isAvailable = false;
      }
    }

    return {
      available: isAvailable,
      requestedNights: stayNights,
      freeCapacityPerNight,
      nominalCapacity: space.nominalCapacity,
      reason: isAvailable ? undefined : 'ظرفیت سالن در یک یا چند شب انتخابی ناکافی است.'
    };
  }

  /**
   * استعلام در دسترس بودن اتاق خصوصی برای تمامی شب‌های اقامت (DEC-0006)
   * اتاق خصوصی کاملاً دربست است و اگر حتی ۱ نفر آن را بگیرد کل اتاق پر می‌شود.
   */
  async checkPrivateRoomAvailability(
    space: Space,
    stayNights: string[],
    now: Date = new Date()
  ): Promise<boolean> {
    if (space.spaceType !== 'PRIVATE_ROOM') {
      throw new Error('INVALID_SPACE_TYPE: فضا باید از نوع اتاق خصوصی باشد.');
    }

    for (const night of stayNights) {
      // آیا رزرو قطعی دارد؟
      const hasConfirmed = Array.from(this.confirmedBookings.values())
        .some(b => b.spaceId === space.id && b.night === night);
      if (hasConfirmed) return false;

      // آیا هولد فعال دارد؟
      const hasActiveHold = Array.from(this.holds.values())
        .some(h =>
          h.spaceId === space.id &&
          h.status === 'ACTIVE' &&
          h.expiresAt > now &&
          h.stayNights.includes(night)
        );
      if (hasActiveHold) return false;
    }

    return true;
  }

  /**
   * ایجاد نگه‌داشت موقت ۲۴ ساعته ظرفیت (Capacity Hold)
   * جلوگیری از Overbooking هم‌زمان از تلگرام و بله (DEC-0025, DEC-0035)
   */
  async createCapacityHold(
    space: Space,
    dto: CreateHoldDTO,
    now: Date = new Date()
  ): Promise<CapacityHold> {
    // بررسی ظرفیت بر اساس نوع فضا
    if (space.spaceType === 'PUBLIC_HALL') {
      const check = await this.checkPublicHallAvailability(space, dto.stayNights, dto.personCount, now);
      if (!check.available) {
        throw new Error('CAPACITY_EXCEEDED: ظرفیت سالن برای شب‌های انتخابی کافی نیست.');
      }
    } else if (space.spaceType === 'PRIVATE_ROOM') {
      // اگر تعداد نفرات بیشتر از ظرفیت اسمی اتاق باشد
      if (dto.personCount > space.nominalCapacity) {
        throw new Error('CAPACITY_EXCEEDED: تعداد نفرات بیش از ظرفیت اسمی اتاق است.');
      }
      const isRoomFree = await this.checkPrivateRoomAvailability(space, dto.stayNights, now);
      if (!isRoomFree) {
        throw new Error('ROOM_OCCUPIED: اتاق در شب‌های انتخابی قبلاً رزرو یا نگه‌داشته شده است.');
      }
    }

    // ایجاد رکورد هولد با مهلت ۲۴ ساعته (DEC-0025)
    const holdId = `hold-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const expiresAt = new Date(now.getTime() + BUSINESS_RULES.STEP_HOLD_VALIDITY_HOURS * 60 * 60 * 1000);

    const hold: CapacityHold = {
      id: holdId,
      placeId: dto.placeId,
      spaceId: dto.spaceId,
      reservationId: dto.reservationId,
      stayNights: dto.stayNights,
      personCount: dto.personCount,
      genderGroup: dto.genderGroup,
      status: 'ACTIVE',
      expiresAt,
      createdAt: now
    };

    this.holds.set(holdId, hold);
    return hold;
  }

  /**
   * آزادسازی هولد موقت (در رد درخواست، انقضا، لغو یا عدم حضور)
   */
  async releaseHold(holdId: string, reason?: string): Promise<void> {
    const hold = this.holds.get(holdId);
    if (!hold) {
      throw new Error('HOLD_NOT_FOUND: نگه‌داشت با این شناسه یافت نشد.');
    }
    hold.status = 'RELEASED';
    this.holds.set(holdId, hold);

    // در صورتی که هولد قبلاً قطعی شده بود، رکوردهای رزرو قطعی را نیز فوراً آزاد کن
    if (hold.reservationId) {
      for (const night of hold.stayNights) {
        const bookingKey = `${hold.spaceId}-${night}-${hold.reservationId}`;
        this.confirmedBookings.delete(bookingKey);
      }
    }
  }

  /**
   * تبدیل هولد به رزرو قطعی (Commit)
   */
  async commitHold(holdId: string, reservationId: string): Promise<void> {
    const hold = this.holds.get(holdId);
    if (!hold) {
      throw new Error('HOLD_NOT_FOUND: نگه‌داشت با این شناسه یافت نشد.');
    }
    if (hold.status !== 'ACTIVE') {
      throw new Error('HOLD_NOT_ACTIVE: نگه‌داشت فعال نیست یا قبلاً لغو شده است.');
    }

    hold.status = 'COMMITTED';
    hold.reservationId = reservationId;

    // ثبت در رکوردهای قطعی برای تمامی شب‌ها
    for (const night of hold.stayNights) {
      const bookingKey = `${hold.spaceId}-${night}-${reservationId}`;
      this.confirmedBookings.set(bookingKey, {
        spaceId: hold.spaceId,
        night,
        personCount: hold.personCount
      });
    }

    this.holds.set(holdId, hold);
  }

  /**
   * دریافت رکورد هولد با شناسه
   */
  async getHoldById(holdId: string): Promise<CapacityHold | undefined> {
    return this.holds.get(holdId);
  }
}
