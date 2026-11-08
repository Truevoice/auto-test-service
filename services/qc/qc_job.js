const cron = require('node-cron')
const log = require('../../utils/log')
const gemini = require('../../api/gemini_api')
const QcSession = require('../../models/qc_session_model')
const QcJobRun = require('../../models/qc_job_run_model')
const QcJobRunCall = require('../../models/qc_job_run_call_model')
const { sampleEndedSessions } = require('./session_repo')
const { getSettings, onChange } = require('./qc_settings')
const { getPromptBundle } = require('./qc_files')
const { buildTranscriptWithTurns, toGsUri } = require('./transcript')
const { checkAudio } = require('./audio_check')
const { findTurnMismatch } = require('./turn_check')
const { isRetryable, backoffDelayMs } = require('./retry_policy')

// กันรอบตรวจซ้อนกันใน process นี้ (เช็กเร็วก่อนถาม DB)
let running = false
let scheduledTask = null

const evaluateWithRetry = async (input) => {
    const maxAttempts = getSettings().maxRetry + 1
    let lastError
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let output
        try {
            output = await gemini.evaluate(input)
        } catch (e) {
            // retry เฉพาะ error จากการเรียก Gemini ที่ลองใหม่แล้วมีโอกาสผ่าน (network, timeout, quota, 5xx, response ว่าง)
            lastError = e
            const retryable = isRetryable(e)
            log.warn({ attempt, status: e.status, retryable, error: e.message }, 'QC: gemini evaluate failed')
            if (!retryable) {
                e.attempts = attempt
                throw e
            }
            if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, backoffDelayMs(attempt, e)))
            continue
        }
        // นับ turn ไม่ตรง (เช่นเอาบรรทัด Bot มาเป็น turn ลูกค้า): ไม่ retry เพื่อประหยัด token, บันทึกเป็น FAILED แทนผลที่ผิด
        const mismatch = findTurnMismatch(output.result, input.customerTurns)
        if (mismatch) {
            const error = new Error(`turn check failed: ${mismatch}`)
            error.attempts = attempt
            throw error
        }
        return { ...output, attempts: attempt }
    }
    lastError.attempts = maxAttempts
    throw lastError
}

// run: { _id, started_at, model, temperature, prompt, schema, prompt_version } ของรอบที่ตรวจสายนี้
const evaluateSession = async (session, run) => {
    const base = {
        session_id: session._id,
        call_recording_url: session.call_recording_url,
        call_created_at: session.created_at,
        model: run.model,
        prompt_version: run.prompt_version,
        job_run_id: run._id,
        job_run_at: run.started_at,
    }
    let update
    try {
        const { transcript, customerTurns } = buildTranscriptWithTurns(session)
        base.transcript = transcript
        const { result, usage, attempts } = await evaluateWithRetry({
            transcript,
            customerTurns,
            audioUri: toGsUri(session.call_recording_url),
            prompt: run.prompt,
            schema: run.schema,
            model: run.model,
            temperature: run.temperature,
        })
        const audioCheck = checkAudio({ audioTokens: usage.audio_tokens, callDurationSeconds: session.duration })
        if (audioCheck.status !== 'OK') {
            log.warn({ bot_session_id: session.bot_session_id, audio_check: audioCheck }, 'QC: audio check flagged')
        }
        update = {
            ...base,
            status: 'DONE',
            qc_result: result,
            usage,
            audio_check: audioCheck,
            error: null,
            attempts,
        }
    } catch (e) {
        update = { ...base, status: 'FAILED', error: e.message, attempts: e.attempts || 1 }
    }
    await QcSession.findOneAndUpdate({ bot_session_id: session.bot_session_id }, update, { upsert: true })
    return update.status
}

// รัน worker พร้อมกันตามจำนวนช่องตรวจ (concurrency) แต่ละช่องมีเลข 1..N ส่งให้ worker ด้วย
// หน้าเว็บใช้เลขช่องแสดงว่าช่องไหนกำลังตรวจสายไหน
const runPool = async (items, worker, concurrency) => {
    let index = 0
    const next = async (slot) => {
        while (index < items.length) {
            const item = items[index++]
            await worker(item, slot)
        }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, (_, i) => next(i + 1)))
}

// อัปเดตสถานะของสายเดียว (เอกสารเล็กของสายนั้น ไม่ต้องเขียนเอกสารรอบทั้งก้อน)
const setCall = (runId, botSessionId, fields) =>
    QcJobRunCall.updateOne({ job_run_id: runId, bot_session_id: botSessionId }, { $set: fields })

// ตัวนับของรอบ $inc แยกจากสถานะสาย ถ้า server ล่มระหว่างสองคำสั่งตัวนับอาจคลาด จึงนับใหม่ตอนจบรอบ
const countRunCalls = async (runId) => {
    const rows = await QcJobRunCall.aggregate([
        { $match: { job_run_id: runId } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
    ])
    const by = Object.fromEntries(rows.map((r) => [r._id, r.n]))
    return { done: by.DONE || 0, failed: by.FAILED || 0 }
}

// เลือกสาย แล้วตรวจทีละช่อง บันทึกความคืบหน้าลง qc_job_run ตลอดทาง
const executeRun = async (run) => {
    const { lookbackHours, samplePercent, minDurationSeconds } = run.options
    try {
        const now = run.started_at
        const { total, docs } = await sampleEndedSessions({ lookbackHours, samplePercent, minDurationSeconds, now })
        const ids = docs.map((doc) => doc.bot_session_id)
        const done = await QcSession.find({ bot_session_id: { $in: ids }, status: 'DONE' }).distinct('bot_session_id')
        const doneSet = new Set(done)
        const todo = docs.filter((doc) => doc.bot_session_id && !doneSet.has(doc.bot_session_id))
        const todoSet = new Set(todo)

        // ใส่สายทั้งหมดของรอบก่อน แล้วค่อยเปลี่ยนเป็น RUNNING หน้าเว็บจะเห็นรายการสายครบตั้งแต่เริ่มตรวจ
        const rows = docs
            .filter((doc) => doc.bot_session_id)
            .map((doc) => ({
                job_run_id: run._id,
                session_id: doc._id,
                bot_session_id: doc.bot_session_id,
                call_created_at: doc.created_at,
                duration: doc.duration,
                status: todoSet.has(doc) ? 'QUEUED' : 'SKIPPED',
            }))
        if (rows.length) await QcJobRunCall.insertMany(rows, { ordered: false })

        await QcJobRun.updateOne(
            { _id: run._id },
            {
                $set: {
                    status: 'RUNNING',
                    calls_from: new Date(now.getTime() - lookbackHours * 60 * 60 * 1000),
                    calls_to: now,
                    total,
                    sampled: docs.length,
                    skipped: docs.length - todo.length,
                },
            },
        )

        await runPool(
            todo,
            async (session, worker) => {
                await setCall(run._id, session.bot_session_id, { status: 'RUNNING', worker, started_at: new Date() })
                const status = await evaluateSession(session, run)
                await setCall(run._id, session.bot_session_id, { status, finished_at: new Date() })
                await QcJobRun.updateOne({ _id: run._id }, { $inc: { [status === 'DONE' ? 'done' : 'failed']: 1 } })
            },
            run.concurrency,
        )

        const finished = await QcJobRun.findOneAndUpdate(
            { _id: run._id },
            { $set: { status: 'DONE', finished_at: new Date(), ...(await countRunCalls(run._id)) } },
            { new: true, lean: true },
        )
        log.info(
            {
                job_run_id: run._id,
                total: finished.total,
                sampled: finished.sampled,
                skipped: finished.skipped,
                done: finished.done,
                failed: finished.failed,
                durationMs: finished.finished_at - finished.started_at,
            },
            'QC: job finished',
        )
    } catch (e) {
        log.error(e, 'QC: job failed')
        await QcJobRun.updateOne(
            { _id: run._id },
            { $set: { status: 'FAILED', error: e.message, finished_at: new Date() } },
        ).catch((err) => log.error(err, 'QC: mark run failed'))
    } finally {
        running = false
    }
}

const ACTIVE = ['SAMPLING', 'RUNNING']

// เริ่มรอบตรวจแล้วคืนทันที (งานจริงทำต่อเบื้องหลัง) หน้าเว็บใช้ job_run id ไปถามความคืบหน้า
// options ที่ไม่ส่งมาใช้ค่าตั้งปัจจุบัน
const startQcJob = async (options = {}, trigger = 'RUN_TASK') => {
    if (running) {
        const current = await QcJobRun.findOne({ status: { $in: ACTIVE } }).sort({ started_at: -1 }).lean()
        return { started: false, run: current }
    }
    running = true
    try {
        const settings = getSettings()
        // ใช้ prompt/schema ชุดเดียวทั้งรอบ แม้มีคนแก้จากหน้าเว็บระหว่างตรวจ
        const { prompt, schema, version } = getPromptBundle()
        const run = await QcJobRun.create({
            trigger,
            status: 'SAMPLING',
            options: {
                lookbackHours: options.lookbackHours ?? settings.lookbackHours,
                samplePercent: options.samplePercent ?? settings.samplePercent,
                minDurationSeconds: options.minDurationSeconds ?? settings.minDurationSeconds,
            },
            model: settings.model,
            prompt_version: version,
            concurrency: settings.concurrency,
            started_at: new Date(),
        })
        const job = { ...run.toObject(), temperature: settings.temperature, prompt, schema }
        executeRun(job) // ไม่ await: งานอาจยาวเกินเวลาที่ proxy/Cloudflare รอได้
        return { started: true, run: run.toObject() }
    } catch (e) {
        running = false
        throw e
    }
}

// รอบที่ค้างสถานะกำลังทำงานจากการรันครั้งก่อน (server รีสตาร์ทกลางรอบ) ไม่มีใครทำต่อแล้ว
const failStaleRuns = () =>
    QcJobRun.updateMany(
        { status: { $in: ACTIVE } },
        { $set: { status: 'FAILED', error: 'server restarted', finished_at: new Date() } },
    )

// ตั้ง/ตั้งใหม่ cron ตามค่าตั้งปัจจุบัน (เรียกตอนเริ่มและทุกครั้งที่แก้ค่าจากหน้าเว็บ)
const applySchedule = (settings = getSettings()) => {
    if (scheduledTask) {
        scheduledTask.destroy()
        scheduledTask = null
    }
    if (!settings.jobEnabled) {
        log.info('QC: job disabled')
        return
    }
    scheduledTask = cron.schedule(
        settings.schedule,
        () =>
            startQcJob({}, 'SCHEDULE')
                .then(({ started }) => started || log.warn('QC: previous run still in progress, skip'))
                .catch((e) => log.error(e, 'QC: scheduled run failed to start')),
        { timezone: 'Asia/Bangkok' },
    )
    log.info(`QC: job scheduled "${settings.schedule}"`)
}

const start = async () => {
    const { modifiedCount } = await failStaleRuns()
    if (modifiedCount) log.warn({ count: modifiedCount }, 'QC: marked unfinished runs as failed')
    applySchedule()
    onChange(applySchedule)
}

module.exports = { start, startQcJob, evaluateSession, evaluateWithRetry, runPool }
