const mongoose = require('mongoose')

// สายแต่ละสายในรอบตรวจ ใช้ดูว่ากำลังตรวจสายไหน เสร็จหรือไม่สำเร็จ
const runCallSchema = new mongoose.Schema(
    {
        session_id: mongoose.Schema.Types.ObjectId,
        bot_session_id: String,
        call_created_at: Date,
        duration: Number,
        status: { type: String, enum: ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED'] },
        // เลขช่องตรวจ (1..concurrency) ที่หยิบสายนี้ไปตรวจ
        worker: Number,
        started_at: Date,
        finished_at: Date,
    },
    { _id: false },
)

// 1 document ต่อการรัน 1 รอบ (ตั้งเวลาหรือสั่งจากหน้าเว็บ)
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
        // hash ของ prompt + schema ที่ใช้ตรวจรอบนี้
        prompt_version: String,
        concurrency: Number,
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
        calls: { type: [runCallSchema], default: [] },
    },
    { collection: 'qc_job_run', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
)

// DB เปิด notablescan ไว้ ทุก query ต้องมี index รองรับ
qcJobRunSchema.index({ started_at: -1 })
qcJobRunSchema.index({ status: 1 })

module.exports = mongoose.model('QcJobRun', qcJobRunSchema)
