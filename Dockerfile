# استخدام صورة Node.js خفيفة ومستقرة
FROM node:18-alpine

# تعيين مجلد العمل داخل الحاوية
WORKDIR /app

# نسخ ملفات التعريف أولاً للاستفادة من التخزين المؤقت
COPY package*.json ./

# تثبيت المكتبات فقط للإنتاج
RUN npm install --omit=dev

# نسخ باقي ملفات المشروع (server.js ومجلد public)
COPY . .

# تعيين متغير البيئة للبيئة الإنتاجية
ENV NODE_ENV=production

# فتح المنفذ الافتراضي (Deplexo عادة تمرر المنفذ عبر PORT)
EXPOSE 3000

# أمر تشغيل الخادم
CMD ["node", "server.js"]
