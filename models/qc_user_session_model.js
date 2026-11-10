const mongoose = require('mongoose')

// session ของผู้ใช้ที่ login แล้ว 1 เอกสารต่อการ login 1 ครั้ง
// _id = sha256 ของค่าใน cookie (ถ้า DB หลุด ก็เอาค่าใน DB ไปใช้เป็น cookie ไม่ได้)
const qcUserSessionSchema = new mongoose.Schema(
    {
        _id: { type: String },
        email: { type: String, required: true },
        name: String,
        picture: String,
        ip: String,
        user_agent: String,
        created_at: Date,
        expires_at: { type: Date, required: true },
    },
    { collection: 'qc_user_session', versionKey: false },
)

// MongoDB ลบ session ที่หมดอายุเอง
qcUserSessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 })

module.exports = mongoose.model('QcUserSession', qcUserSessionSchema)
