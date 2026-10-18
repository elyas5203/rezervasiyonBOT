/**
 * ماژول ثبت موکب، فضاها و سالن/اتاق‌ها و تأیید ادمین
 * منبع حقیقت: DEC-0002, DEC-0004, DEC-0005, DEC-0006, DEC-0007, DEC-0010, DEC-0011, DEC-0014, DEC-0019, DEC-0027, DEC-0038, DEC-0041, DEC-0044
 */

import {
  ApprovalMode,
  FinancialModel,
  GenderGroup,
  MokabPlace,
  MokabStatus,
  Space,
  SpaceType,
  SupplyType
} from '../types.js';

export interface RegisterMokabDTO {
  hostPersonId: string;
  title: string;
  city: string;
  address: string;
  contactName: string;
  contactPhone: string;
  placePhotoPath: string;               // عکس محل (DEC-0041)
  responsibilityDocumentPath: string;   // مدرک مسئولیت (DEC-0041)
  supplyType: SupplyType;               // عمومی، خصوصی یا هر دو (DEC-0005)
  financialModel: FinancialModel;       // رایگان، هزینه ثابت، تضمین ثابت (DEC-0011)
  feeAmountToman?: number;              // به تومان (DEC-0038)
  depositAmountToman?: number;          // به تومان (DEC-0038)
  approvalMode: ApprovalMode;           // فوری یا دستی (DEC-0010)
  cancellationRules?: string;           // قوانین لغو موکب‌دار (DEC-0014)
}

export interface InventoryRepository {
  createPlace(place: MokabPlace): Promise<MokabPlace>;
  updatePlace(place: MokabPlace): Promise<MokabPlace>;
  findPlaceById(id: string): Promise<MokabPlace | null>;
  findPlacesByHost(hostPersonId: string): Promise<MokabPlace[]>;
  findApprovedPlaces(city?: string): Promise<MokabPlace[]>;

  createSpace(space: Space): Promise<Space>;
  findSpaceById(id: string): Promise<Space | null>;
  findSpacesByPlaceId(placeId: string): Promise<Space[]>;
}

/**
 * پیاده‌سازی ذخیره‌ساز در حافظه برای آزمون‌های محلی ایزوله و مطمئن
 */
export class InMemoryInventoryRepository implements InventoryRepository {
  private places: Map<string, MokabPlace> = new Map();
  private spaces: Map<string, Space> = new Map();

  async createPlace(place: MokabPlace): Promise<MokabPlace> {
    this.places.set(place.id, { ...place });
    return place;
  }

  async updatePlace(place: MokabPlace): Promise<MokabPlace> {
    this.places.set(place.id, { ...place });
    return place;
  }

  async findPlaceById(id: string): Promise<MokabPlace | null> {
    return this.places.get(id) || null;
  }

  async findPlacesByHost(hostPersonId: string): Promise<MokabPlace[]> {
    return Array.from(this.places.values()).filter(p => p.hostPersonId === hostPersonId);
  }

  async findApprovedPlaces(city?: string): Promise<MokabPlace[]> {
    return Array.from(this.places.values()).filter(p => {
      const isApproved = p.status === 'APPROVED';
      if (!isApproved) return false;
      if (city && city.trim().length > 0) {
        return p.city.trim().toLowerCase() === city.trim().toLowerCase();
      }
      return true;
    });
  }

  async createSpace(space: Space): Promise<Space> {
    this.spaces.set(space.id, { ...space });
    return space;
  }

  async findSpaceById(id: string): Promise<Space | null> {
    return this.spaces.get(id) || null;
  }

  async findSpacesByPlaceId(placeId: string): Promise<Space[]> {
    return Array.from(this.spaces.values()).filter(s => s.placeId === placeId);
  }
}

/**
 * شهرهای عربستان که طبق DEC-0002 صراحتاً از دامنه سامانه خارج هستند
 */
const FORBIDDEN_SAUDI_CITIES = ['مکه', 'مدینه', 'جده', 'ریاض', 'طائف', 'mecca', 'medina', 'jeddah', 'riyadh'];

/**
 * سرویس مدیریت موکب‌ها و فضاهای اسکان
 */
export class InventoryService {
  constructor(private repo: InventoryRepository = new InMemoryInventoryRepository()) {}

  /**
   * ثبت اولیه موکب توسط موکب‌دار (وضعیت اولیه همیشه PENDING است)
   */
  async registerMokabPlace(dto: RegisterMokabDTO): Promise<MokabPlace> {
    // ۱. بررسی شهر: شهرهای عربستان ممنوع هستند (DEC-0002)
    const normalizedCity = dto.city.trim().toLowerCase();
    for (const forbidden of FORBIDDEN_SAUDI_CITIES) {
      if (normalizedCity.includes(forbidden)) {
        throw new Error(`FORBIDDEN_CITY: شهرهای عربستان (${dto.city}) خارج از دامنه این سامانه هستند (DEC-0002).`);
      }
    }

    // ۲. بررسی مدارک پایه ۴گانه (DEC-0041): نام/شماره مسئول، نشانی، عکس، مدرک مسئولیت
    if (!dto.contactName || dto.contactName.trim().length === 0) {
      throw new Error('MISSING_DOCUMENT: نام مسئول موکب الزامی است (DEC-0041).');
    }
    if (!dto.contactPhone || dto.contactPhone.trim().length === 0) {
      throw new Error('MISSING_DOCUMENT: شماره تماس مسئول موکب الزامی است (DEC-0041).');
    }
    if (!dto.address || dto.address.trim().length === 0) {
      throw new Error('MISSING_DOCUMENT: نشانی دقیق موکب الزامی است (DEC-0041).');
    }
    if (!dto.placePhotoPath || dto.placePhotoPath.trim().length === 0) {
      throw new Error('MISSING_DOCUMENT: ارسال عکس محل اقامتگاه الزامی است (DEC-0041).');
    }
    if (!dto.responsibilityDocumentPath || dto.responsibilityDocumentPath.trim().length === 0) {
      throw new Error('MISSING_DOCUMENT: ارسال مدرک مسئولیت موکب الزامی است (DEC-0041).');
    }

    // ۳. مدل‌های مالی انحصاری (DEC-0011) و مبالغ به تومان (DEC-0038)
    let feeAmount = 0;
    let depositAmount = 0;

    if (dto.financialModel === 'FIXED_FEE') {
      if (!dto.feeAmountToman || dto.feeAmountToman <= 0) {
        throw new Error('INVALID_FEE: برای مدل هزینه ثابت، مبلغ باید بزرگتر از صفر تومان باشد.');
      }
      feeAmount = Math.floor(dto.feeAmountToman);
    } else if (dto.financialModel === 'FIXED_DEPOSIT') {
      if (!dto.depositAmountToman || dto.depositAmountToman <= 0) {
        throw new Error('INVALID_DEPOSIT: برای مدل تضمین ثابت، مبلغ تضمین باید بزرگتر از صفر تومان باشد.');
      }
      depositAmount = Math.floor(dto.depositAmountToman);
    }

    const now = new Date();
    const place: MokabPlace = {
      id: `place-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      hostPersonId: dto.hostPersonId,
      title: dto.title.trim(),
      city: dto.city.trim(),
      address: dto.address.trim(),
      contactName: dto.contactName.trim(),
      contactPhone: dto.contactPhone.trim(),
      status: 'PENDING', // تا زمان تأیید ادمین پنهان می‌ماند (DEC-0004)
      supplyType: dto.supplyType,
      financialModel: dto.financialModel,
      approvalMode: dto.approvalMode,
      feeAmountToman: feeAmount,
      depositAmountToman: depositAmount,
      cancellationRules: dto.cancellationRules?.trim() || 'قوانین عمومی موکب',
      createdAt: now
    };

    return this.repo.createPlace(place);
  }

  /**
   * ثبت سالن عمومی با تفکیک جنسیت الزامی (DEC-0007)
   */
  async registerPublicHall(
    placeId: string,
    title: string,
    genderGroup: GenderGroup,
    nominalCapacity: number
  ): Promise<Space> {
    const place = await this.repo.findPlaceById(placeId);
    if (!place) {
      throw new Error('PLACE_NOT_FOUND: موکب مورد نظر یافت نشد.');
    }
    if (place.supplyType === 'PRIVATE') {
      throw new Error('SUPPLY_MISMATCH: این موکب صرفاً برای اتاق‌های خصوصی ثبت شده است.');
    }
    if (nominalCapacity <= 0) {
      throw new Error('INVALID_CAPACITY: ظرفیت سالن باید بزرگتر از صفر باشد.');
    }

    const space: Space = {
      id: `space-hall-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      placeId,
      spaceType: 'PUBLIC_HALL',
      title: title.trim(),
      genderGroup,
      nominalCapacity,
      createdAt: new Date()
    };

    return this.repo.createSpace(space);
  }

  /**
   * ثبت دسته‌ای اتاق‌های همسان (DEC-0006)
   * فرمول «تعداد × ظرفیت»: هر اتاق یک رکورد فیزیکی مستقل ایجاد می‌کند، نه یک ظرفیت تجمیعی.
   */
  async registerPrivateRoomsBatch(
    placeId: string,
    titlePrefix: string,
    roomCount: number,
    nominalCapacity: number
  ): Promise<Space[]> {
    const place = await this.repo.findPlaceById(placeId);
    if (!place) {
      throw new Error('PLACE_NOT_FOUND: موکب مورد نظر یافت نشد.');
    }
    if (place.supplyType === 'PUBLIC') {
      throw new Error('SUPPLY_MISMATCH: این موکب صرفاً برای سالن‌های عمومی ثبت شده است.');
    }
    if (roomCount <= 0) {
      throw new Error('INVALID_COUNT: تعداد اتاق‌ها باید حداقل ۱ باشد.');
    }
    if (nominalCapacity <= 0) {
      throw new Error('INVALID_CAPACITY: ظرفیت هر اتاق باید حداقل ۱ نفر باشد.');
    }

    const createdRooms: Space[] = [];
    const now = new Date();

    for (let i = 1; i <= roomCount; i++) {
      const room: Space = {
        id: `space-room-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 6)}`,
        placeId,
        spaceType: 'PRIVATE_ROOM',
        title: `${titlePrefix.trim()} شماره ${i}`,
        genderGroup: 'ALL', // اتاق خصوصی دربست برای یک خانواده/گروه است
        nominalCapacity,     // کودک نیز در این ظرفیت شمرده می‌شود (DEC-0027)
        createdAt: now
      };
      const saved = await this.repo.createSpace(room);
      createdRooms.push(saved);
    }

    return createdRooms;
  }

  /**
   * بررسی و تصمیم‌گیری ادمین برای پرونده موکب (DEC-0004, DEC-0019)
   */
  async reviewMokabPlace(
    placeId: string,
    reviewerPersonId: string,
    decision: 'APPROVED' | 'REJECTED',
    rejectionReason?: string
  ): Promise<MokabPlace> {
    const place = await this.repo.findPlaceById(placeId);
    if (!place) {
      throw new Error('PLACE_NOT_FOUND: موکب مورد نظر یافت نشد.');
    }

    place.status = decision;
    if (decision === 'REJECTED' && rejectionReason) {
      place.cancellationRules = `علت رد: ${rejectionReason} | ${place.cancellationRules}`;
    }

    return this.repo.updatePlace(place);
  }

  /**
   * دریافت موکب‌های تأییدشده برای نمایش در جست‌وجوی زائران (DEC-0004)
   * موکب‌های در انتظار (PENDING) یا ردشده (REJECTED) هرگز بازگردانده نمی‌شوند.
   */
  async getApprovedPlaces(city?: string): Promise<MokabPlace[]> {
    return this.repo.findApprovedPlaces(city);
  }

  /**
   * دریافت فضاهای یک موکب
   */
  async getSpacesByPlaceId(placeId: string): Promise<Space[]> {
    return this.repo.findSpacesByPlaceId(placeId);
  }

  /**
   * دریافت موکب با شناسه
   */
  async getPlaceById(placeId: string): Promise<MokabPlace | null> {
    return this.repo.findPlaceById(placeId);
  }
}
