const mongoose = require('mongoose')

// 1 document ต่อ 1 สายใน 1 รอบตรวจ (แยกจาก qc_job_run เพื่อไม่ให้เอกสารรอบโตตามจำนวนสาย)
// สถานะสายอัปเดตทีละเอกสารเล็กๆ ส่วนตัวนับรวมยังอยู่ที่ qc_job_run
const qcJobRunCallSchema = new mongoose.Schema(
    {
        job_run_id: { type: mongoose.Schema.Types.ObjectId, required: true },
        session_id: mongoose.Schema.Types.ObjectId,
        bot_session_id: { type: String, required: true },
        call_created_at: Date,
        duration: Number,
        // QUEUED = รอคิว, RUNNING = กำลังตรวจ, SKIPPED = เคยตรวจแล้วจากรอบก่อน
        status: { type: String, enum: ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED'], required: true },
        // เลขช่องตรวจ (1..concurrency) ที่หยิบสายนี้ไปตรวจ
        worker: Number,
        started_at: Date,
        finished_at: Date,
    },
    { collection: 'qc_job_run_call', versionKey: false },
)

// DB เปิด notablescan ไว้ ทุก query ต้องมี index รองรับ
// อัปเดตสายตรงตัว และกันสายซ้ำในรอบเดียวกัน
qcJobRunCallSchema.index({ job_run_id: 1, bot_session_id: 1 }, { unique: true })
// รายการสายของรอบ เรียงตามลำดับที่เลือกมา (แบ่งชุดด้วย _id)
qcJobRunCallSchema.index({ job_run_id: 1, _id: 1 })
// กรองตามสถานะ เช่นหาสายที่กำลังตรวจเพื่อแสดงช่องตรวจ และนับใหม่ตอนจบรอบ
qcJobRunCallSchema.index({ job_run_id: 1, status: 1, _id: 1 })

module.exports = mongoose.model('QcJobRunCall', qcJobRunCallSchema)
