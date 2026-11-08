const log = require('../../utils/log')
const QcJobRun = require('../../models/qc_job_run_model')
const QcJobRunCall = require('../../models/qc_job_run_call_model')
const QcSetting = require('../../models/qc_setting_model')

const MARK_ID = 'migration:run_calls'
const STATUSES = ['SAMPLING', 'RUNNING', 'DONE', 'FAILED']

// รอบตรวจเก่าเก็บสายไว้ใน array qc_job_run.calls ย้ายไป qc_job_run_call แล้วลบ array ออก
// ทำครั้งเดียวต่อ DB (จดไว้ใน qc_setting) และทำซ้ำได้ปลอดภัย: upsert ตาม (job_run_id, bot_session_id)
// เดินตาม index status เพราะ DB เปิด notablescan (ไม่มี index ที่บอกได้ว่ารอบไหนยังมี calls)
const migrateRunCalls = async () => {
    if (await QcSetting.exists({ _id: MARK_ID })) return
    let runs = 0
    let calls = 0
    const cursor = QcJobRun.collection.find({ status: { $in: STATUSES } }, { projection: { calls: 1 } })
    for await (const run of cursor) {
        if (!Array.isArray(run.calls)) continue
        const ops = run.calls
            .filter((c) => c.bot_session_id)
            .map((c) => ({
                updateOne: {
                    filter: { job_run_id: run._id, bot_session_id: c.bot_session_id },
                    update: { $setOnInsert: { ...c, job_run_id: run._id } },
                    upsert: true,
                },
            }))
        if (ops.length) await QcJobRunCall.bulkWrite(ops, { ordered: false })
        await QcJobRun.collection.updateOne({ _id: run._id }, { $unset: { calls: '' } })
        runs++
        calls += ops.length
    }
    await QcSetting.updateOne({ _id: MARK_ID }, { $set: { values: { runs, calls, at: new Date() } } }, { upsert: true })
    log.info({ runs, calls }, 'QC: moved run calls to qc_job_run_call')
}

module.exports = { migrateRunCalls }
