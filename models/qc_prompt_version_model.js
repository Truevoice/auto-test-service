const mongoose = require('mongoose')

// สำเนา prompt + schema ตามเวอร์ชัน (_id = prompt_version ที่รอบตรวจกับผลตรวจเก็บไว้)
// แก้ prompt จากหน้าเว็บแล้ว รอบเก่ายังเปิดดูได้ว่าตอนนั้นใช้คำสั่งแบบไหน
// เวอร์ชันเดียวกันเนื้อหาเหมือนกันเสมอ (hash ของเนื้อหา) จึงเขียนครั้งเดียวไม่ต้องแก้
const qcPromptVersionSchema = new mongoose.Schema(
    {
        _id: { type: String },
        prompt: String,
        schema: String,
    },
    { collection: 'qc_prompt_version', versionKey: false, timestamps: { createdAt: 'created_at', updatedAt: false } },
)

module.exports = mongoose.model('QcPromptVersion', qcPromptVersionSchema)
