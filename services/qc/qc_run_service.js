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

module.exports = { toRunView, getLatestRun, getRun }
