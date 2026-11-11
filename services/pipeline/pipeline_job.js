const crypto = require('crypto')
const os = require('os')
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
const LOCK = 'active'

// process นี้ (หลาย server/container ใช้ DB เดียวกันได้ แยกกันด้วยชื่อนี้)
const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`
// ยืนยันว่ายังทำรอบอยู่ทุก HEARTBEAT_MS ถ้าเงียบเกิน STALE_MS ถือว่า process ที่ทำอยู่ล่ม ให้ตัวอื่นรับไปทำต่อ
const HEARTBEAT_MS = Number(process.env.PIPELINE_HEARTBEAT_MS || 10_000)
const STALE_MS = Number(process.env.PIPELINE_STALE_MS || 30_000)
const RECOVER_MS = Math.max(1000, Math.floor(STALE_MS / 2))

let running = false
let stopping = false
let currentRun = null
let scheduledTask = null
let recoverTimer = null

// รอบนี้ถูก process อื่นรับไปแล้ว (เราเงียบนานเกินไป เช่นเครื่องค้าง) ต้องหยุดทันที ไม่เขียนทับกัน
class LeaseLostError extends Error {
    constructor(runId) {
        super(`pipeline run ${runId} is now owned by another process`)
        this.code = 'LEASE_LOST'
    }
}

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

// ดึงทีละชุด (limit) จนหมดช่วง เขียนทับลงฐาน eval แล้วค่อยเลื่อน cursor (ล่มกลางชุด = ดึงชุดนั้นซ้ำ เขียนทับได้ไม่เสียหาย)
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
        {
            $set: { ...fields, finished_at: finishedAt, duration_ms: run?.started_at ? finishedAt - run.started_at : null },
            $unset: { lock: '' },
        },
        { returnDocument: 'after', lean: true },
    )
}

const failRun = async (runId, reason) => finishRun(runId, { status: 'FAILED', error: reason })

// งานของรอบ: เปิดฐานต้นทาง (นับถ้ายังไม่ได้นับ) แล้วดึงทีละชุดจนจบ ปิดการเชื่อมต่อทุกครั้ง
// เขียนความคืบหน้าเฉพาะถ้ายังเป็นเจ้าของรอบ (ถ้าไม่ใช่แล้ว แปลว่ามี process อื่นรับไปทำต่อ)
const updateOwned = async (runId, update) => {
    const res = await PipelineRun.updateOne({ _id: runId, owner: INSTANCE_ID }, update)
    if (!res.matchedCount) throw new LeaseLostError(runId)
}

const execute = async (runId, isLost) => {
    const run = await PipelineRun.findById(runId).lean()
    const range = { from: run.range_from, to: run.range_to }
    const source = await openSource(targetUri())
    try {
        const sessions = source.db.collection(COLLECTION)
        if (run.status === 'COUNTING') {
            const total = await sessions.countDocuments(rangeFilter(range))
            await updateOwned(runId, { $set: { status: 'RUNNING', total, batches: batchCount(total, run.limit) } })
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
            shouldStop: () => stopping || isLost(),
            onBatch: ({ cursor, count }) =>
                updateOwned(runId, { $set: { cursor, heartbeat_at: new Date() }, $inc: { batch_done: 1, copied: count } }),
        })
        if (isLost()) throw new LeaseLostError(runId)
        if (result === 'STOPPED') {
            // ปิดระบบแบบปกติ: ปล่อยรอบให้ process ถัดไปรับทำต่อได้ทันที ไม่ต้องรอให้ถือว่าเงียบนาน
            await PipelineRun.updateOne({ _id: runId, owner: INSTANCE_ID }, { $set: { heartbeat_at: new Date(0) } })
            log.warn({ pipeline_run_id: runId }, 'Pipeline: stopped mid-run, released for resume after restart')
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
    let lost = false
    // ยืนยันว่ายังทำอยู่ (ช่วงนับจำนวนหรือชุดที่ช้าก็ยังส่ง) ถ้าเจ้าของเปลี่ยนแล้วให้หยุด
    const heartbeat = setInterval(() => {
        PipelineRun.updateOne({ _id: runId, owner: INSTANCE_ID }, { $set: { heartbeat_at: new Date() } })
            .then((res) => {
                if (!res.matchedCount) lost = true
            })
            .catch((e) => log.warn({ pipeline_run_id: runId, error: e.message }, 'Pipeline: heartbeat failed'))
    }, HEARTBEAT_MS)
    heartbeat.unref()
    currentRun = (async () => {
        try {
            await execute(runId, () => lost)
        } catch (e) {
            if (e.code === 'LEASE_LOST') {
                log.warn({ pipeline_run_id: runId }, 'Pipeline: run taken over by another process, stopped here')
            } else {
                log.error({ pipeline_run_id: runId, code: e.code, error: e.message }, 'Pipeline: run failed')
                await failRun(runId, e.code || e.message).catch((err) => log.error(err, 'Pipeline: mark run failed'))
            }
        } finally {
            clearInterval(heartbeat)
            running = false
            currentRun = null
        }
    })()
}

const currentActive = () => PipelineRun.findOne({ status: { $in: ACTIVE } }).sort({ started_at: -1 }).lean()

// เริ่มรอบแล้วคืนทันที (งานจริงทำเบื้องหลัง) หน้าเว็บถามความคืบหน้าด้วย id
// มีรอบกำลังทำอยู่ (จาก process ไหนก็ตาม) = ไม่เริ่ม คืนรอบนั้นแทน: กันด้วย unique index ของ lock จึงไม่มีจังหวะชนกัน
const startPipeline = async ({ from, to, limit }, trigger = 'MANUAL', triggeredBy = null) => {
    if (stopping) return { started: false, stopping: true, run: null }
    if (running) return { started: false, run: await currentActive() }
    running = true
    try {
        const now = new Date()
        const run = await PipelineRun.create({
            trigger,
            triggered_by: triggeredBy,
            status: 'COUNTING',
            range_from: from,
            range_to: to,
            limit: limit ?? getSettings().batchLimit,
            lock: LOCK,
            owner: INSTANCE_ID,
            heartbeat_at: now,
            started_at: now,
        })
        runInBackground(run._id)
        return { started: true, run: run.toObject() }
    } catch (e) {
        running = false
        if (e.code === 11000) return { started: false, run: await currentActive() }
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

// รับรอบที่ค้างมาทำต่อจาก cursor: เฉพาะรอบที่เจ้าของเงียบนานเกิน STALE_MS (process นั้นล่มหรือปิดไปแล้ว)
// รอบที่ process อื่นยังทำอยู่จะไม่ถูกแตะ รับด้วย findOneAndUpdate ครั้งเดียว จึงมีแค่ process เดียวที่ได้รอบไป
// เรียกตอนเริ่มระบบ และทุก RECOVER_MS (process ที่ทำอยู่ล่มเมื่อไรก็มีตัวอื่นรับต่อ)
const claimStaleRun = async () => {
    if (running || stopping) return
    const now = new Date()
    let run
    try {
        run = await PipelineRun.findOneAndUpdate(
            {
                status: { $in: ACTIVE },
                $or: [{ heartbeat_at: { $lt: new Date(now.getTime() - STALE_MS) } }, { heartbeat_at: null }],
            },
            {
                $set: { owner: INSTANCE_ID, heartbeat_at: now, resumed_at: now, lock: LOCK },
                $inc: { resume_count: 1 },
            },
            { sort: { started_at: -1 }, returnDocument: 'after', lean: true },
        )
    } catch (e) {
        // รอบเก่าที่ค้าง (ก่อนมี lock) แต่มีรอบอื่นถือ lock อยู่แล้ว: ปิดรอบเก่านั้น
        if (e.code !== 11000) throw e
        const legacy = await PipelineRun.findOne({ status: { $in: ACTIVE }, lock: { $exists: false } }).lean()
        if (legacy) await failRun(legacy._id, 'server restarted')
        return
    }
    if (!run) return
    if (run.resume_count > MAX_RESUME) {
        log.warn({ pipeline_run_id: run._id, resume_count: run.resume_count }, 'Pipeline: run resumed too many times, giving up')
        await failRun(run._id, 'server restarted too many times')
        return
    }
    running = true
    log.warn({ pipeline_run_id: run._id, status: run.status, batch_done: run.batch_done }, 'Pipeline: resuming run')
    runInBackground(run._id)
}

const recoverTick = () => claimStaleRun().catch((e) => log.error(e, 'Pipeline: recover check failed'))

const shutdown = async (graceMs = 25000) => {
    stopping = true
    if (recoverTimer) {
        clearInterval(recoverTimer)
        recoverTimer = null
    }
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
    await claimStaleRun()
    recoverTimer = setInterval(recoverTick, RECOVER_MS)
    recoverTimer.unref()
    applySchedule()
    onChange(applySchedule)
}

module.exports = { start, shutdown, startPipeline, countRange, copyBatches, cursorFilter, batchCount, isRunning: () => running }
