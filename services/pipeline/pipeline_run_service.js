const mongoose = require('mongoose')
const PipelineRun = require('../../models/pipeline_run_model')

// เวลาต่อชุดตั้งต้นตอนยังไม่มีประวัติ (ms) ใช้ประมาณเวลาเท่านั้น
const DEFAULT_BATCH_MS = 1500

// error จริงอาจมี host/path ของฐานต้นทาง หน้าเว็บได้แค่เหตุผลแบบกว้างๆ
const failedReason = (status, error = '') => {
    if (status !== 'FAILED') return null
    if (error === 'server restarted too many times') return 'RESTART_LIMIT'
    if (String(error).startsWith('server restarted')) return 'SERVER_RESTARTED'
    if (error === 'NOT_CONFIGURED') return 'NOT_CONFIGURED'
    return 'ERROR'
}

// ไม่ส่ง error และ cursor (_id ของ session ต้นทาง) ออกไป
const toRunView = (run) => {
    if (!run) return null
    const { error, cursor, __v, ...rest } = run
    return { ...rest, failed_reason: failedReason(run.status, error) }
}

const getRun = async (id) => {
    if (!mongoose.isValidObjectId(id)) return null
    return toRunView(await PipelineRun.findById(id).lean())
}

const getActiveRun = async () =>
    toRunView(await PipelineRun.findOne({ status: { $in: ['COUNTING', 'RUNNING'] } }).sort({ started_at: -1 }).lean())

// feed ประวัติ ใหม่ก่อน แบ่งชุดด้วย before = started_at ของรอบสุดท้ายที่หน้าเว็บมีแล้ว
const listRuns = async ({ before, limit = 30 } = {}) => {
    const filter = before ? { started_at: { $lt: before } } : {}
    const found = await PipelineRun.find(filter).sort({ started_at: -1 }).limit(limit + 1).lean()
    const items = found.slice(0, limit).map(toRunView)
    return { items, next_before: found.length > limit ? items[items.length - 1].started_at : null }
}

// เวลาเฉลี่ยต่อชุดจาก 5 รอบที่เสร็จล่าสุด (มีอย่างน้อย 1 ชุด และไม่ได้ทำต่อหลังรีสตาร์ท เพราะเวลารวมช่วงที่ระบบดับไว้ด้วย)
const averageBatchMs = async () => {
    const runs = await PipelineRun.find({ status: 'DONE' }, { duration_ms: 1, batch_done: 1, resume_count: 1 })
        .sort({ started_at: -1 })
        .limit(20)
        .lean()
    const useful = runs.filter((r) => r.batch_done > 0 && r.duration_ms > 0 && !r.resume_count).slice(0, 5)
    const batches = useful.reduce((n, r) => n + r.batch_done, 0)
    if (!batches) return { avgBatchMs: DEFAULT_BATCH_MS, estimated: false }
    return { avgBatchMs: Math.round(useful.reduce((n, r) => n + r.duration_ms, 0) / batches), estimated: true }
}

module.exports = { getRun, getActiveRun, listRuns, averageBatchMs, failedReason, toRunView, DEFAULT_BATCH_MS }
