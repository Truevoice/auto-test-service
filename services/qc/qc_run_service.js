const mongoose = require('mongoose')
const QcJobRun = require('../../models/qc_job_run_model')

// error จริงอาจมี path หรือรายละเอียดภายใน หน้าเว็บได้แค่เหตุผลแบบกว้างๆ
const toRunView = (run) => {
    if (!run) return null
    const { error, ...rest } = run
    return {
        ...rest,
        failed_reason: run.status !== 'FAILED' ? null : error === 'server restarted' ? 'SERVER_RESTARTED' : 'ERROR',
    }
}

const getLatestRun = async () => toRunView(await QcJobRun.findOne().sort({ started_at: -1 }).lean())

const getRun = async (id) => {
    if (!mongoose.isValidObjectId(id)) return null
    return toRunView(await QcJobRun.findById(id).lean())
}

// รายการรอบตรวจ ใหม่ก่อน ไม่มีรายการสาย (เอกสารเล็ก ถามบ่อยได้) เรียงด้วย index started_at
// จำนวนทั้งหมดใช้ estimatedDocumentCount เพราะ DB เปิด notablescan (countDocuments({}) ต้องสแกนทั้ง collection)
const listRuns = async ({ page = 1, limit = 20 } = {}) => {
    const [items, total] = await Promise.all([
        QcJobRun.find({}, { calls: 0 })
            .sort({ started_at: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        QcJobRun.estimatedDocumentCount(),
    ])
    return { items: items.map(toRunView), total, page, limit }
}

module.exports = { toRunView, getLatestRun, getRun, listRuns }
