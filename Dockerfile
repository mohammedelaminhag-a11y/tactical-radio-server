# استخدام صورة Node.js خفيفة ومستقرة
FROM node:18-alpine

# تثبيت أدوات البناء الضرورية لترجمة مكتبة OpusScript (حتى لا يفشل npm install)
RUN apk add --no-cache python3 make g++

# تعيين مجلد العمل داخل الحاوية
WORKDIR /app

# نسخ ملفات التعريف أولاً للاستفادة من التخزين المؤقت
COPY package*.json ./

# تثبيت جميع المكتبات (بما فيها بناء الحزم الأصلية)
RUN npm install

# نسخ باقي ملفات المشروع (server.js ومجلد public)
COPY . .

# تعيين متغير البيئة للبيئة الإنتاجية
ENV NODE_ENV=production

# فتح المنفذ (متوافق مع المنفذ 8080 أو ما ترسله المنصة عبر PORT)
EXPOSE 8080

# أمر تشغيل الخادم
CMD ["node", "server.js"]
