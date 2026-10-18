# ==============================================================================
# Dockerfile برای سامانه رزرواسیون اسکان زائر
# فناوری: Bun Runtime با ایمیج سبک و اجرای امن بدون دسترسی Root
# ==============================================================================

FROM oven/bun:1-alpine AS base
WORKDIR /app

# نصب ابزار curl برای healthcheck در محیط alpine
RUN apk add --no-cache curl

# کپی مانیفست پکیج‌ها و نصب وابستگی‌ها
COPY package.json ./
RUN bun install --production

# کپی کدهای منبع و تنظیمات تایپ‌اسکریپت
COPY tsconfig.json ./
COPY src/ ./src/

# ایجاد مسیر داده‌های محلی و تنظیم مالکیت برای کاربر کم‌امتیاز bun
RUN mkdir -p /app/data && chown -R bun:bun /app

# تغییر کاربر اجرا به کاربر غیر روت
USER bun

# تنظیم متغیرهای محیطی پیش‌فرض
ENV NODE_ENV=production
ENV PORT=3000
ENV STORAGE_PATH=/app/data

# پورت پیش‌فرض کانتینر
EXPOSE 3000

# پروب بررسی سلامت کانتینر
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT}/healthz || exit 1

# دستور اجرای سامانه
CMD ["bun", "run", "src/index.ts"]
