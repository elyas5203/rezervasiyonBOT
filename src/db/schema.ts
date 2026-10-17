/**
 * تعاریف اسکیما، محدودیت‌ها و قوانین اعتبارسنجی پایگاه داده
 * منبع حقیقت: DECISIONS.md و MASTER-15
 */

import {
  BUSINESS_RULES,
  ChannelAccount,
  LinkCode,
  MokabPlace,
  Person,
  ReceiptRecord,
  ReservationRequest,
  Space
} from '../core/types.js';

/**
 * ایجاد کد پیوند حساب جدید با انقضای دقیقاً ۲۴ ساعته (DEC-0040)
 */
export function generateLinkCode(personId: string, code: string, issuedAt: Date = new Date()): LinkCode {
  const expiresAt = new Date(issuedAt.getTime() + BUSINESS_RULES.LINK_CODE_VALIDITY_HOURS * 60 * 60 * 1000);
  return {
    id: `link-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    personId,
    code,
    expiresAt,
    usedAt: null
  };
}

/**
 * اعتبارسنجی کد پیوند: بررسی انقضای ۲۴ ساعته و عدم استفاده قبلی (DEC-0040)
 */
export function validateLinkCode(linkCode: LinkCode, currentTime: Date = new Date()): { isValid: boolean; reason?: string } {
  if (linkCode.usedAt !== null && linkCode.usedAt !== undefined) {
    return { isValid: false, reason: 'CODE_ALREADY_USED' };
  }
  if (currentTime.getTime() > linkCode.expiresAt.getTime()) {
    return { isValid: false, reason: 'CODE_EXPIRED' };
  }
  return { isValid: true };
}

/**
 * محاسبه پایان مهلت نگه‌داشت ظرفیت برای گام فعلی انتظار (DEC-0025, DEC-0035)
 */
export function calculateHoldExpiration(stepStartTime: Date = new Date()): Date {
  return new Date(stepStartTime.getTime() + BUSINESS_RULES.STEP_HOLD_VALIDITY_HOURS * 60 * 60 * 1000);
}

/**
 * بررسی قانون هفت روز پیش از تاریخ ورود بر اساس تاریخ شهر مقصد (DEC-0033, DEC-0034)
 * برای مثال ورود ۲۰ آبان: آخرین مهلت ثبت، پایان روز ۱۳ آبان است.
 */
export function isRequestAllowedByCutoff(
  checkInDateStr: string, // فرمت YYYY-MM-DD
  requestDateStr: string  // فرمت YYYY-MM-DD به وقت مقصد
): { isAllowed: boolean; lastAllowedDate: string } {
  const checkIn = new Date(`${checkInDateStr}T00:00:00Z`);
  const cutoffTime = checkIn.getTime() - (BUSINESS_RULES.CUTOFF_DAYS_BEFORE_CHECKIN * 24 * 60 * 60 * 1000);
  const cutoffDate = new Date(cutoffTime);
  const lastAllowedDate = cutoffDate.toISOString().split('T')[0];

  const requestDate = new Date(`${requestDateStr}T00:00:00Z`);
  const isAllowed = requestDate.getTime() <= cutoffDate.getTime();

  return { isAllowed, lastAllowedDate };
}

/**
 * اعتبارسنجی ظرفیت اسمی اتاق بدون استثنای کودک و تفکیک جنسیتی سالن (DEC-0007, DEC-0027)
 */
export function validateSpaceCapacity(
  space: Space,
  maleCount: number,
  femaleCount: number,
  childCount: number
): { isAllowed: boolean; reason?: string } {
  const totalCount = maleCount + femaleCount + childCount;

  if (totalCount <= 0) {
    return { isAllowed: false, reason: 'TOTAL_COUNT_ZERO' };
  }

  // در اتاق خصوصی، ظرفیت اسمی ثابت است و کودک نیز شمرده می‌شود (DEC-0027)
  if (space.spaceType === 'PRIVATE_ROOM') {
    if (totalCount > space.nominalCapacity) {
      return {
        isAllowed: false,
        reason: `EXCEEDS_ROOM_CAPACITY: نفرات (${totalCount}) بیش از ظرفیت اسمی اتاق (${space.nominalCapacity}) است.`
      };
    }
  }

  // در سالن عمومی، تفکیک جنسیت الزامی است (DEC-0007)
  if (space.spaceType === 'PUBLIC_HALL') {
    if (space.genderGroup === 'MEN' && femaleCount > 0) {
      return { isAllowed: false, reason: 'GENDER_MISMATCH_MEN_ONLY' };
    }
    if (space.genderGroup === 'WOMEN' && maleCount > 0) {
      return { isAllowed: false, reason: 'GENDER_MISMATCH_WOMEN_ONLY' };
    }
    if (totalCount > space.nominalCapacity) {
      return { isAllowed: false, reason: 'EXCEEDS_HALL_CAPACITY' };
    }
  }

  return { isAllowed: true };
}

/**
 * اعتبارسنجی زائر خارجی: بدون پرداخت در سامانه و همراه با تصویر گذرنامه (DEC-0032, DEC-0036)
 */
export function validateForeignPilgrimBooking(
  isForeign: boolean,
  hasPassportImage: boolean,
  feePaidToman: number
): { isAllowed: boolean; reason?: string } {
  if (isForeign) {
    // زائر خارجی نباید هیچ مبلغی در سامانه بپردازد
    if (feePaidToman > 0) {
      return { isAllowed: false, reason: 'FOREIGN_PILGRIM_CANNOT_PAY_IN_APP' };
    }
    // مدرک گذرنامه برای زائر خارجی الزامی است
    if (!hasPassportImage) {
      return { isAllowed: false, reason: 'PASSPORT_IMAGE_REQUIRED' };
    }
  }
  return { isAllowed: true };
}
