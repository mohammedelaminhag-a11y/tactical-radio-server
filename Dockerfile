# استخدام صورة Debian Slim بدلاً من Alpine لتفادي مشاكل تجميع Opus
FROM node:18-slim

# تعيين مجلد العمل
WORKDIR /app

# نسخ ملفات التعريف
COPY package*.json ./

# تثبيت المكتبات (تأكد أن package.json لا يحتوي على node_modules محلي)
RUN npm install --omit=dev

# نسخ باقي الملفات
COPY . .

# تعيين بيئة التشغيل
ENV NODE_ENV=production

# فتح المنفذ
EXPOSE 8080

# أمر التشغيل
CMD ["node", "server.js"]
