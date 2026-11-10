const mongoose = require('mongoose')

const { QC_AUDIT_RETENTION_DAYS = '365' } = process.env

// ประวัติการใช้งาน: ใคร (อีเมล) ทำอะไร เมื่อไร จากที่ไหน
const qcAuditLogSchema = new mongoose.Schema(
    {
        at: { type: Date, required: true },
        // null สำหรับเหตุการณ์ที่ยังไม่รู้ตัวผู้ใช้ เช่น login ไม่ผ่าน
        email: String,
        name: String,
        // LOGIN, LOGIN_DENIED, LOGOUT, RUN_START, CONFIG_UPDATE, FILE_UPDATE, VIEW_CALL
        action: { type: String, required: true },
        // สิ่งที่ถูกกระทำ เช่น job_run id, ชื่อไฟล์, bot_session_id
        target: String,
        // รายละเอียดเพิ่ม เช่นค่าก่อน/หลังแก้ (ไม่มีค่าลับหรือเนื้อหา prompt ทั้งไฟล์)
        detail: mongoose.Schema.Types.Mixed,
        ip: String,
        user_agent: String,
    },
    { collection: 'qc_audit_log', versionKey: false },
)

// ดูทั้งหมด / กรองตามผู้ใช้ / กรองตามการกระทำ เรียงใหม่ก่อน (แบ่งชุดด้วย _id)
qcAuditLogSchema.index({ email: 1, _id: -1 })
qcAuditLogSchema.index({ action: 1, _id: -1 })
// เก็บย้อนหลังตาม QC_AUDIT_RETENTION_DAYS แล้ว MongoDB ลบเอง
qcAuditLogSchema.index({ at: 1 }, { expireAfterSeconds: Number(QC_AUDIT_RETENTION_DAYS) * 24 * 60 * 60 })

module.exports = mongoose.model('QcAuditLog', qcAuditLogSchema)
