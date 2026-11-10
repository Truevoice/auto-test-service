const mongoose = require('mongoose')

// 1 document ต่อการดึงข้อมูล 1 รอบ (data-pipeline: sessions จากฐานต้นทาง -> ฐาน eval)
const pipelineRunSchema = new mongoose.Schema(
    {
        trigger: { type: String, enum: ['SCHEDULE', 'MANUAL'] },
        // คนที่กดสั่ง (ไม่มีสำหรับรอบที่ระบบตั้งเวลา)
        triggered_by: { email: String, name: String },
        // COUNTING = กำลังนับจำนวนที่ต้นทาง, RUNNING = กำลังดึงทีละชุด
        status: { type: String, enum: ['COUNTING', 'RUNNING', 'DONE', 'FAILED'] },
        // ช่วงเวลาของ sessions.created_at ที่ดึง [range_from, range_to)
        range_from: Date,
        range_to: Date,
        // ดึงครั้งละกี่ session และจำนวนชุดทั้งหมด = ceil(total / limit)
        limit: Number,
        total: { type: Number, default: 0 },
        batches: { type: Number, default: 0 },
        batch_done: { type: Number, default: 0 },
        copied: { type: Number, default: 0 },
        // session สุดท้ายที่เขียนลงฐาน eval แล้ว ใช้ดึงชุดถัดไป และทำต่อหลังรีสตาร์ท
        cursor: { created_at: Date, _id: mongoose.Schema.Types.Mixed },
        resume_count: { type: Number, default: 0 },
        resumed_at: Date,
        started_at: Date,
        finished_at: Date,
        duration_ms: Number,
        // ข้อความ error จริง เก็บไว้ดูฝั่ง server ไม่ส่งให้หน้าเว็บ
        error: String,
    },
    { collection: 'pipeline_run', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
)

// DB เปิด notablescan ไว้ ทุก query ต้องมี index รองรับ
pipelineRunSchema.index({ started_at: -1 })
// หารอบที่ค้าง และค่าเฉลี่ยเวลาต่อชุดจากรอบที่เสร็จล่าสุด (ใช้ประมาณเวลา)
pipelineRunSchema.index({ status: 1, started_at: -1 })

module.exports = mongoose.model('PipelineRun', pipelineRunSchema)
