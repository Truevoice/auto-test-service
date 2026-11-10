const mongoose = require('mongoose')

// ผู้ใช้ที่เคย login เข้าระบบ (_id = อีเมล) ใช้แสดงชื่อในประวัติการใช้งานและตัวกรองผู้ใช้
const qcUserSchema = new mongoose.Schema(
    {
        _id: { type: String },
        name: String,
        picture: String,
        first_login_at: Date,
        last_login_at: Date,
        login_count: { type: Number, default: 0 },
    },
    { collection: 'qc_user', versionKey: false },
)

// รายชื่อผู้ใช้เรียงตามการ login ล่าสุด (DB เปิด notablescan)
qcUserSchema.index({ last_login_at: -1 })

module.exports = mongoose.model('QcUser', qcUserSchema)
