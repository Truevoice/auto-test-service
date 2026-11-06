const mongoose = require('mongoose')

const qcSessionSchema = new mongoose.Schema(
    {
        bot_session_id: { type: String, required: true, unique: true },
        session_id: { type: mongoose.Schema.Types.ObjectId, index: true },
        call_recording_url: String,
        transcript: String,
        status: { type: String, enum: ['DONE', 'FAILED'], index: true },
        qc_result: mongoose.Schema.Types.Mixed,
        // token จาก Gemini usageMetadata (audio_tokens > 0 = โมเดลได้รับเสียงจริง)
        usage: {
            prompt_tokens: Number,
            audio_tokens: Number,
            text_tokens: Number,
            output_tokens: Number,
            thoughts_tokens: Number,
            total_tokens: Number,
        },
        // เทียบความยาวเสียงที่โมเดลได้รับกับความยาวสาย
        audio_check: {
            status: { type: String, enum: ['OK', 'NO_AUDIO', 'DURATION_MISMATCH', 'NO_DURATION'] },
            audio_tokens: Number,
            estimated_audio_seconds: Number,
            call_duration_seconds: Number,
            diff_seconds: Number,
            diff_pct: Number,
        },
        model: String,
        // hash ของ prompt + schema ที่ใช้ตรวจ (เปลี่ยน prompt แล้วแยกผลเก่ากับใหม่ได้)
        prompt_version: String,
        error: String,
        attempts: Number,
        call_created_at: Date,
        // รอบตรวจล่าสุดที่ตรวจสายนี้ (qc_job_run)
        job_run_id: mongoose.Schema.Types.ObjectId,
        job_run_at: Date,
    },
    { collection: 'qc_session', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
)

// DB เปิด notablescan ไว้ ทุก query ต้องมี index รองรับ
qcSessionSchema.index({ call_created_at: -1, status: 1 })

module.exports = mongoose.model('QcSession', qcSessionSchema)
