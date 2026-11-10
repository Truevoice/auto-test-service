const cron = require('node-cron')
const mongoose = require('mongoose')
const log = require('../../utils/log')
const PipelineRun = require('../../models/pipeline_run_model')
const { openSource } = require('../../db/source_mongo')
const { targetUri } = require('../../db/mongo')
const { getSettings, onChange, scheduleOf } = require('./pipeline_settings')

// data-pipeline: ดึง sessions จากฐานต้นทางทีละชุด (limit) มาเขียนทับลงฐาน eval ตาม _id
// ทำทีละรอบ ทำต่อจาก cursor หลังรีสตาร์ทได้

const COLLECTION = 'sessions'
const MAX_RESUME = 2
const BATCH_RETRY = 2
const ACTIVE = ['COUNTING', 'RUNNING']

let running = false
let stopping = false
let currentRun = null
let scheduledTask = null

const batchCount = (total, limit) => (total > 0 && limit > 0 ? Math.ceil(total / limit) : 0)

const rangeFilter = ({ from, to }) => ({ created_at: { $gte: from, $lt: to } })

// ชุดถัดไปต่อจาก session สุดท้ายที่เขียนแล้ว (keyset: created_at แล้ว _id) ไม่ใช้ skip จึงไม่ช้าลงเมื่อลึก
const cursorFilter = (range, cursor) => {
    const base = rangeFilter(range)
    if (!cursor?.created_at) return base
    return {
        $and: [
            base,
            {
                $or: [
                    { created_at: { $gt: cursor.created_at } },
                    { created_at: cursor.created_at, _id: { $gt: cursor._id } },
                ],
            },
        ],
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const withRetry = async (fn, label) => {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn()
        } catch (e) {
            if (attempt > BATCH_RETRY) throw e
            log.warn({ attempt, error: e.message }, `Pipeline: ${label} failed, retrying`)
            await sleep(1000 * 2 ** (attempt - 1))
        }
    }
}

// ดึงทีละชุดจนหมดช่วง เขียนทับลงฐาน eval แล้วค่อยเลื่อน cursor (ล่มกลางชุด = ดึงชุดนั้นซ้ำ เขียนทับได้ไม่เสียหาย)
// source/target = collection ของ driver, onBatch({ cursor, count }) บันทึกความคืบหน้า
// คืน 'DONE' หรือ 'STOPPED' (ระบบกำลังปิด)
const copyBatches = async ({ source, target, range, limit, cursor = null, onBatch, shouldStop = () => false }) => {
    let last = cursor
    for (;;) {
        if (shouldStop()) return 'STOPPED'
        const docs = await withRetry(
            () =>
                source
                    .find(cursorFilter(range, last))
                    .sort({ created_at: 1, _id: 1 })
                    .limit(limit)
                    .toArray(),
            'read batch',
        )
        if (!docs.length) return 'DONE'
        await withRetry(
            () =>
                target.bulkWrite(
                    docs.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })),
                    { ordered: false },
                ),
            'write batch',
        )
        const end = docs[docs.length - 1]
        last = { created_at: end.created_at, _id: end._id }
        await onBatch({ cursor: last, count: docs.length })
        if (docs.length < limit) return 'DONE'
    }
}

// index ที่ฐาน eval ต้องมีสำหรับ sessions (notablescan): สุ่มสายตามเวลา และ join ผลตรวจ
const ensureTargetIndexes = async (target) => {
    for (const keys of [{ created_at: 1 }, { bot_session_id: 1 }]) {
        try {
            await target.createIndex(keys)
        } catch (e) {
            // มี index แบบเดียวกันแต่ชื่อ/ตัวเลือกต่างอยู่แล้ว ใช้ของเดิมได้
            log.warn({ keys, error: e.message }, 'Pipeline: ensure sessions index skipped')
        }
    }
}

// ปิดรอบพร้อมเวลาที่ใช้ (async: error ใดๆ กลายเป็น promise reject ไม่ทำให้ process ล่ม)
const finishRun = async (runId, fields) => {
    const run = await PipelineRun.findById(runId, { started_at: 1 }).lean()
    const finishedAt = new Date()
    return PipelineRun.findOneAndUpdate(
        { _id: runId },
        { $set: { ...fields, finished_at: finishedAt, duration_ms: run?.started_at ? finishedAt - run.started_at : null } },
        { returnDocument: 'after', lean: true },
    )
}

const failRun = async (runId, reason) => finishRun(runId, { status: 'FAILED', error: reason })

// งานของรอบ: เปิดฐานต้นทาง (นับถ้ายังไม่ได้นับ) แล้วดึงทีละชุดจนจบ ปิดการเชื่อมต่อทุกครั้ง
const execute = async (runId) => {
    const run = await PipelineRun.findById(runId).lean()
    const range = { from: run.range_from, to: run.range_to }
    const source = await openSource(targetUri())
    try {
        const sessions = source.db.collection(COLLECTION)
        if (run.status === 'COUNTING') {
            const total = await sessions.countDocuments(rangeFilter(range))
            await PipelineRun.updateOne(
                { _id: runId },
                { $set: { status: 'RUNNING', total, batches: batchCount(total, run.limit) } },
            )
            log.info({ pipeline_run_id: runId, total, limit: run.limit }, 'Pipeline: counted')
        }
        const target = mongoose.connection.db.collection(COLLECTION)
        await ensureTargetIndexes(target)
        const result = await copyBatches({
            source: sessions,
            target,
            range,
            limit: run.limit,
            cursor: run.cursor?.created_at ? run.cursor : null,
            shouldStop: () => stopping,
            onBatch: ({ cursor, count }) =>
                PipelineRun.updateOne({ _id: runId }, { $set: { cursor }, $inc: { batch_done: 1, copied: count } }),
        })
        if (result === 'STOPPED') {
            log.warn({ pipeline_run_id: runId }, 'Pipeline: stopped mid-run, will resume after restart')
            return
        }
        const done = await finishRun(runId, { status: 'DONE' })
        log.info(
            { pipeline_run_id: runId, total: done.total, copied: done.copied, batches: done.batch_done, durationMs: done.duration_ms },
            'Pipeline: run finished',
        )
    } finally {
        await source.close()
    }
}

const runInBackground = (runId) => {
    currentRun = (async () => {
        try {
            await execute(runId)
        } catch (e) {
            log.error({ pipeline_run_id: runId, code: e.code, error: e.message }, 'Pipeline: run failed')
            await failRun(runId, e.code || e.message).catch((err) => log.error(err, 'Pipeline: mark run failed'))
        } finally {
            running = false
            currentRun = null
        }
    })()
}

// เริ่มรอบแล้วคืนทันที (งานจริงทำเบื้องหลัง) หน้าเว็บถามความคืบหน้าด้วย id
const startPipeline = async ({ from, to, limit }, trigger = 'MANUAL', triggeredBy = null) => {
    if (stopping) return { started: false, stopping: true, run: null }
    if (running || (await PipelineRun.exists({ status: { $in: ACTIVE } }))) {
        const current = await PipelineRun.findOne({ status: { $in: ACTIVE } }).sort({ started_at: -1 }).lean()
        return { started: false, run: current }
    }
    running = true
    try {
        const run = await PipelineRun.create({
            trigger,
            triggered_by: triggeredBy,
            status: 'COUNTING',
            range_from: from,
            range_to: to,
            limit: limit ?? getSettings().batchLimit,
            started_at: new Date(),
        })
        runInBackground(run._id)
        return { started: true, run: run.toObject() }
    } catch (e) {
        running = false
        throw e
    }
}

// นับจำนวน session ในช่วงเวลา (หน้าเว็บใช้ก่อนเริ่ม เพื่อคำนวณจำนวนชุดและเวลา)
const countRange = async ({ from, to }) => {
    const source = await openSource(targetUri())
    try {
        return await source.db.collection(COLLECTION).countDocuments(rangeFilter({ from, to }))
    } finally {
        await source.close()
    }
}

// ทำรอบที่ค้างจากครั้งก่อนต่อจาก cursor (ล่มหรือ deploy กลางรอบ) เกิน MAX_RESUME ครั้งปิดเป็น FAILED
const recoverRuns = async () => {
    const stale = await PipelineRun.find({ status: { $in: ACTIVE } }).sort({ started_at: -1 }).lean()
    if (!stale.length) return
    const [latest, ...older] = stale
    for (const r of older) await failRun(r._id, 'server restarted')
    if ((latest.resume_count || 0) >= MAX_RESUME) {
        log.warn({ pipeline_run_id: latest._id }, 'Pipeline: run resumed too many times, giving up')
        await failRun(latest._id, 'server restarted too many times')
        return
    }
    running = true
    await PipelineRun.updateOne({ _id: latest._id }, { $inc: { resume_count: 1 }, $set: { resumed_at: new Date() } })
    log.warn({ pipeline_run_id: latest._id, status: latest.status, batch_done: latest.batch_done }, 'Pipeline: resuming run')
    runInBackground(latest._id)
}

const shutdown = async (graceMs = 25000) => {
    stopping = true
    if (scheduledTask) {
        scheduledTask.destroy()
        scheduledTask = null
    }
    if (!currentRun) return
    log.warn({ graceMs }, 'Pipeline: shutting down, waiting for the batch in progress')
    let timer
    await Promise.race([currentRun, new Promise((r) => (timer = setTimeout(r, graceMs)))])
    clearTimeout(timer)
}

// รอบตั้งเวลา: ดึงช่วง N ชั่วโมงล่าสุด ด้วย limit ตามค่าตั้ง
const applySchedule = (settings = getSettings()) => {
    if (scheduledTask) {
        scheduledTask.destroy()
        scheduledTask = null
    }
    if (!settings.enabled) {
        log.info('Pipeline: job disabled')
        return
    }
    const expression = scheduleOf(settings.intervalHours)
    scheduledTask = cron.schedule(
        expression,
        () => {
            const { intervalHours, batchLimit } = getSettings()
            const to = new Date()
            const from = new Date(to.getTime() - intervalHours * 60 * 60 * 1000)
            startPipeline({ from, to, limit: batchLimit }, 'SCHEDULE')
                .then(({ started }) => started || log.warn('Pipeline: previous run still in progress, skip'))
                .catch((e) => log.error(e, 'Pipeline: scheduled run failed to start'))
        },
        { timezone: 'Asia/Bangkok' },
    )
    log.info(`Pipeline: job scheduled "${expression}"`)
}

const start = async () => {
    await recoverRuns()
    applySchedule()
    onChange(applySchedule)
}

module.exports = { start, shutdown, startPipeline, countRange, copyBatches, cursorFilter, batchCount, isRunning: () => running }
