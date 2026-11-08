FROM node:22-alpine

WORKDIR /opt/app/
COPY package*.json ./
# ติดตั้งตาม package-lock เป๊ะๆ และไม่เอา devDependencies (mocha, eslint, ...) ลง image
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .

# ไม่รันเป็น root (แอปไม่เขียนไฟล์ลงเครื่องตอนทำงาน)
USER node
EXPOSE 3000
# เรียก node ตรงๆ (ไม่ผ่าน npm) ให้ SIGTERM ตอน deploy ถึงแอป รอบตรวจจะได้หยุดอย่างนุ่มนวล
CMD ["node", "app.js"]
