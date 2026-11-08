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

const ACTIVE = ['SAMPLING', 'RUNNING']
const NO_CALLS = { calls: 0 }

// รายการรอบตรวจแบบ feed ใหม่ก่อน ไม่มีรายการสาย (เอกสารเล็ก ถามบ่อยได้)
// แบ่งชุดด้วย cursor: before = started_at ของรอบสุดท้ายที่หน้าเว็บมีแล้ว (ไม่ใช้ skip รอบใหม่เข้ามาก็ไม่ซ้ำไม่หาย)
// hideEmpty: ซ่อนรอบที่ไม่มีสายให้ตรวจ แต่รอบที่กำลังทำงานแสดงเสมอ (ตอนเลือกสาย sampled ยังเป็น 0)
const listRuns = async ({ before, limit = 30, hideEmpty = false } = {}) => {
    const filter = before ? { started_at: { $lt: before } } : {}
    let query = QcJobRun.find(hideEmpty ? { ...filter, sampled: { $gt: 0 } } : filter, NO_CALLS)
        .sort({ started_at: -1 })
        .limit(limit + 1)
    if (hideEmpty) query = query.hint({ started_at: -1, sampled: 1 })
    const [found, active] = await Promise.all([
        query.lean(),
        hideEmpty && !before ? QcJobRun.find({ status: { $in: ACTIVE } }, NO_CALLS).lean() : [],
    ])
    const hasMore = found.length > limit
    const page = found.slice(0, limit)
    const ids = new Set(page.map((r) => String(r._id)))
    const items = [...page, ...active.filter((r) => !ids.has(String(r._id)))].sort((x, y) => y.started_at - x.started_at)
    return { items: items.map(toRunView), next_before: hasMore ? page[page.length - 1].started_at : null }
}

module.exports = { toRunView, getLatestRun, getRun, listRuns }
