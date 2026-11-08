const mongoose = require('mongoose')

// 1 document ต่อการรัน 1 รอบ (ตั้งเวลาหรือสั่งจากหน้าเว็บ) สายแต่ละสายอยู่ใน qc_job_run_call
const qcJobRunSchema = new mongoose.Schema(
    {
        trigger: { type: String, enum: ['SCHEDULE', 'RUN_TASK'] },
        // SAMPLING = กำลังเลือกสาย, RUNNING = กำลังตรวจ
        status: { type: String, enum: ['SAMPLING', 'RUNNING', 'DONE', 'FAILED'] },
        options: {
            lookbackHours: Number,
            samplePercent: Number,
            minDurationSeconds: Number,
        },
        model: String,
        temperature: Number,
        // hash ของ prompt + schema ที่ใช้ตรวจรอบนี้
        prompt_version: String,
        concurrency: Number,
        // จำนวนครั้งที่ลองใหม่สูงสุดต่อสาย ตอนเริ่มรอบนี้
        max_retry: Number,
        calls_from: Date,
        calls_to: Date,
        total: { type: Number, default: 0 },
        sampled: { type: Number, default: 0 },
        skipped: { type: Number, default: 0 },
        done: { type: Number, default: 0 },
        failed: { type: Number, default: 0 },
        started_at: Date,
        finished_at: Date,
        // ข้อความ error จริง เก็บไว้ดูฝั่ง server ไม่ส่งให้หน้าเว็บ
        error: String,
    },
    { collection: 'qc_job_run', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
)

// DB เปิด notablescan ไว้ ทุก query ต้องมี index รองรับ
qcJobRunSchema.index({ started_at: -1 })
qcJobRunSchema.index({ status: 1 })
// หน้า "รอบตรวจ" ซ่อนรอบที่ไม่มีสาย: เดินตาม started_at แล้วกรอง sampled จาก key ใน index (ไม่ต้องอ่านเอกสาร)
qcJobRunSchema.index({ started_at: -1, sampled: 1 })

module.exports = mongoose.model('QcJobRun', qcJobRunSchema)
