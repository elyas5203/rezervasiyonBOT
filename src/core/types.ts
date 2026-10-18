/**
 * انواع داده‌های هسته بیزینس و وضعیت‌های مصوب سامانه رزرو اسکان زائر
 * منبع حقیقت: DEC-0001 تا DEC-0044 و مسترهای مصوب
 */

/** درگاه‌های پیام‌رسان مصوب (DEC-0003) */
export type ChannelType = 'TELEGRAM' | 'BALE';

/** وضعیت تأیید موکب توسط ادمین (DEC-0004, DEC-0019, DEC-0041) */
export type MokabStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

/** انواع عرضه اسکان (DEC-0005) */
export type SupplyType = 'PUBLIC' | 'PRIVATE' | 'BOTH';

/** مدل‌های مالی انحصاری سامانه (DEC-0011) */
export type FinancialModel = 'FREE' | 'FIXED_FEE' | 'FIXED_DEPOSIT';

/** روش تأیید درخواست توسط موکب‌دار (DEC-0010) */
export type ApprovalMode = 'INSTANT' | 'MANUAL';

/** نوع فضای اسکان (DEC-0005, DEC-0006) */
export type SpaceType = 'PUBLIC_HALL' | 'PRIVATE_ROOM';

/** تفکیک جنسیتی سالن‌های عمومی (DEC-0007) */
export type GenderGroup = 'MEN' | 'WOMEN' | 'ALL';

/** وضعیت‌های ماشین چرخه حیات رزرو (DEC-0010, DEC-0025, DEC-0032) */
export type ReservationStatus =
  | 'PENDING_HOST_APPROVAL'       // در انتظار تأیید موکب‌دار در تأیید دستی
  | 'PENDING_PAYMENT_RECEIPT'      // در انتظار واریز و ارسال رسید توسط زائر (۲۴ ساعت)
  | 'PENDING_RECEIPT_VERIFICATION' // در انتظار بررسی و تأیید رسید توسط موکب‌دار (۲۴ ساعت)
  | 'CONFIRMED'                    // قطعی شده
  | 'CANCELLED'                    // لغو شده (توسط زائر یا انقضای مهلت)
  | 'NO_SHOW'                      // عدم حضور
  | 'COMPLETED';                   // اقامت پایان‌یافته

/** وضعیت بررسی رسید واریز کارت‌به‌کارت (DEC-0012, DEC-0020) */
export type ReceiptVerificationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/** ثابت‌های زمانی و اعتبارسنجی مصوب بیزینس */
export const BUSINESS_RULES = {
  /** مدت اعتبار کد پیوند حساب به ساعت (DEC-0040) */
  LINK_CODE_VALIDITY_HOURS: 24,

  /** مهلت هر گام انتظار و نگه‌داشت ظرفیت به ساعت (DEC-0025, DEC-0035) */
  STEP_HOLD_VALIDITY_HOURS: 24,

  /** آخرین مهلت ثبت درخواست چند روز پیش از ورود است (DEC-0033) */
  CUTOFF_DAYS_BEFORE_CHECKIN: 7,

  /** مدت نگهداری تصویر گذرنامه زائر خارجی به روز (DEC-0036, DEC-0037) */
  PASSPORT_RETENTION_DAYS: 30,

  /** واحد مجاز تمام مبالغ در سامانه (DEC-0038) */
  CURRENCY: 'TOMAN',
} as const;

/** موجودیت شخص (حساب مرکزی یکپارچه) */
export interface Person {
  id: string;
  phoneNumber?: string | null; // در اولین ورود null است (DEC-0043)
  createdAt: Date;
  updatedAt: Date;
}

/** حساب متصل در پیام‌رسان */
export interface ChannelAccount {
  id: string;
  personId: string;
  channelType: ChannelType;
  channelUserId: string;
  createdAt: Date;
}

/** کد پیوند حساب دو پیام‌رسان */
export interface LinkCode {
  id: string;
  personId: string;
  code: string;
  expiresAt: Date;
  usedAt?: Date | null;
}

/** اقامتگاه / موکب */
export interface MokabPlace {
  id: string;
  hostPersonId: string;
  title: string;
  city: string;
  address: string;
  contactName: string;
  contactPhone: string;
  status: MokabStatus;
  supplyType: SupplyType;
  financialModel: FinancialModel;
  approvalMode: ApprovalMode;
  feeAmountToman: number;
  depositAmountToman: number;
  cancellationRules: string;
  createdAt: Date;
}

/** فضای اسکان (سالن یا اتاق) */
export interface Space {
  id: string;
  placeId: string;
  spaceType: SpaceType;
  title: string;
  genderGroup: GenderGroup;
  nominalCapacity: number; // همه کودکان نیز شمرده می‌شوند (DEC-0027)
  createdAt: Date;
}

/** سیاست تقویم و ظرفیت در تاریخ مشخص */
export interface CalendarPolicy {
  id: string;
  spaceId: string;
  targetDate: string; // YYYY-MM-DD
  isActive: boolean;
  capacityOverride?: number | null;
}

/** درخواست رزرو اسکان */
export interface ReservationRequest {
  id: string;
  trackingCode: string;
  personId: string;
  contactPhone: string;
  placeId: string;
  spaceId: string;
  checkInDate: string;  // YYYY-MM-DD
  checkOutDate: string; // YYYY-MM-DD
  maleCount: number;
  femaleCount: number;
  childCount: number;
  totalCount: number;
  status: ReservationStatus;
  holdId?: string | null;
  holdExpiresAt?: Date | null;
  cancellationRulesSnapshot: string; // قانون لغو در زمان ثبت رزرو فریز می‌شود (DEC-0014)
  isForeignPilgrim: boolean;
  passportImagePath?: string | null;
  passportDeletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** سند رسید پرداخت کارت‌به‌کارت */
export interface ReceiptRecord {
  id: string;
  reservationId: string;
  receiptImagePath: string;
  uploadedAt: Date;
  verificationStatus: ReceiptVerificationStatus;
  verifiedAt?: Date | null;
  rejectionReason?: string | null;
}

/** قوانین فعالیت و اقامت موکب (DEC-0009) */
export interface PlaceOperatingRules {
  placeId: string;
  startDate?: string | null; // YYYY-MM-DD
  endDate?: string | null;   // YYYY-MM-DD
  maxStayNights: number;     // سقف مجاز اقامت
  checkInHour: number;       // ساعت مجاز ورود (مثلاً ۱۴)
  checkOutHour: number;      // ساعت تخلیه و خروج (مثلاً ۱۲)
}

/** وضعیت نگه‌داشت موقت ظرفیت (DEC-0025, DEC-0035) */
export type CapacityHoldStatus = 'ACTIVE' | 'RELEASED' | 'COMMITTED';

/** رکورد نگه‌داشت موقت ظرفیت */
export interface CapacityHold {
  id: string;
  placeId: string;
  spaceId: string;
  reservationId?: string | null;
  stayNights: string[]; // آرایه شب‌های اقامت YYYY-MM-DD
  personCount: number;  // برای سالن: تعداد نفرات؛ برای اتاق: ۱ اتاق (یا ظرفیت اسمی اتاق)
  genderGroup: GenderGroup;
  status: CapacityHoldStatus;
  expiresAt: Date;
  createdAt: Date;
}

