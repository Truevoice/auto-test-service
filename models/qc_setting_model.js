const mongoose = require('mongoose')

// ค่าตั้งของงานตรวจที่แก้จากหน้าเว็บ
// _id = 'qc': ค่าตั้งทั่วไปใน values
// _id = 'file:promptFile' / 'file:schemaFile': เนื้อหาไฟล์คำสั่งและรูปแบบผลตรวจใน content
const qcSettingSchema = new mongoose.Schema(
    {
        _id: { type: String },
        values: { type: mongoose.Schema.Types.Mixed, default: {} },
        content: String,
    },
    { collection: 'qc_setting', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, minimize: false },
)

module.exports = mongoose.model('QcSetting', qcSettingSchema)
