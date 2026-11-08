const cron = require('node-cron')
const log = require('../../utils/log')
const gemini = require('../../api/gemini_api')
const QcSession = require('../../models/qc_session_model')
const QcJobRun = require('../../models/qc_job_run_model')
const QcJobRunCall = require('../../models/qc_job_run_call_model')
const { sampleEndedSessions, loadSessionsByIds } = require('./session_repo')
const { getSettings, onChange } = require('./qc_settings')
const { savePromptVersion, getPromptVersion } = require('./qc_files')
const { buildTranscriptWithTurns, toGsUri } = require('./transcript')
const { checkAudio } = require('./audio_check')
const { findTurnMismatch } = require('./turn_check')
const { isRetryable, backoffDelayMs } = require('./retry_policy')

// กันรอบตรวจซ้อนกันใน process นี้ (เช็กเร็วก่อนถาม DB)
let running = false
let scheduledTask = null
// ระบบกำลังปิด (deploy/รีสตาร์ท): หยุดหยิบสายใหม่ สายที่กำลังตรวจให้จบ ที่เหลือทำต่อตอนเริ่มใหม่
let stopping = false
// promise ของรอบที่กำลังทำอยู่ ใช้รอตอนปิดระบบ
let currentRun = null

// ทำต่อหลังระบบรีสตาร์ทได้กี่ครั้งต่อรอบ เกินนี้ปิดรอบ (กันรอบที่ทำให้ระบบล่มวนไม่จบ)
const MAX_RESUME = 2

// maxRetry มาจากค่าของรอบ (รอบที่ทำต่อหลังรีสตาร์ทใช้ค่าเดิม) ไม่ส่งมาใช้ค่าตั้งปัจจุบัน
const evaluateWithRetry = async (input, maxRetry = getSettings().maxRetry) => {
    const maxAttempts = maxRetry + 1
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
        }, run.max_retry ?? undefined)
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
// shouldStop() เป็นจริง: ไม่หยิบรายการใหม่ แต่รายการที่กำลังทำอยู่ทำจนจบ
const runPool = async (items, worker, concurrency, shouldStop = () => false) => {
    let index = 0
    const next = async (slot) => {
        while (index < items.length && !shouldStop()) {
            const item = items[index++]
            await worker(item, slot)
        }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, (_, i) => next(i + 1)))
}

// อัปเดตสถานะของสายเดียว (เอกสารเล็กของสายนั้น ไม่ต้องเขียนเอกสารรอบทั้งก้อน)
const setCall = (runId, botSessionId, fields) =>
    QcJobRunCall.updateOne(
        { job_run_id: runId, bot_session_id: botSessionId },
        { $set: { ...fields, updated_at: new Date() } },
    )

// ตัวนับของรอบ $inc แยกจากสถานะสาย ถ้า server ล่มระหว่างสองคำสั่งตัวนับอาจคลาด จึงนับใหม่ตอนจบรอบ
const countRunCalls = async (runId) => {
    const rows = await QcJobRunCall.aggregate([
        { $match: { job_run_id: runId } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
    ])
    const by = Object.fromEntries(rows.map((r) => [r._id, r.n]))
    return { done: by.DONE || 0, failed: by.FAILED || 0, cancelled: by.CANCELLED || 0 }
}

// เลือกสายของรอบ บันทึกรายการสายลง qc_job_run_call แล้วเปลี่ยนรอบเป็น RUNNING คืน session ที่ต้องตรวจ
const sampleCalls = async (run) => {
    const { lookbackHours, samplePercent, minDurationSeconds } = run.options
    const now = run.started_at
    const { total, docs } = await sampleEndedSessions({ lookbackHours, samplePercent, minDurationSeconds, now })
    const ids = docs.map((doc) => doc.bot_session_id)
    const done = await QcSession.find({ bot_session_id: { $in: ids }, status: 'DONE' }).distinct('bot_session_id')
    const doneSet = new Set(done)
    const todo = docs.filter((doc) => doc.bot_session_id && !doneSet.has(doc.bot_session_id))
    const todoSet = new Set(todo)

    // ใส่สายทั้งหมดของรอบก่อน แล้วค่อยเปลี่ยนเป็น RUNNING หน้าเว็บจะเห็นรายการสายครบตั้งแต่เริ่มตรวจ
    const insertedAt = new Date()
    const rows = docs
        .filter((doc) => doc.bot_session_id)
        .map((doc) => ({
            job_run_id: run._id,
            session_id: doc._id,
            bot_session_id: doc.bot_session_id,
            call_created_at: doc.created_at,
            duration: doc.duration,
            status: todoSet.has(doc) ? 'QUEUED' : 'SKIPPED',
            updated_at: insertedAt,
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
    return todo
}

// ตรวจทีละช่องจนหมดคิว แล้วปิดรอบเป็น DONE
// ถ้าระบบกำลังปิด: หยุดหยิบสายใหม่ ปล่อยรอบไว้เป็น RUNNING ให้ทำต่อตอนเริ่มใหม่ (recoverRuns)
const processCalls = async (run, sessions) => {
    await runPool(
        sessions,
        async (session, worker) => {
            await setCall(run._id, session.bot_session_id, { status: 'RUNNING', worker, started_at: new Date() })
            const status = await evaluateSession(session, run)
            await setCall(run._id, session.bot_session_id, { status, finished_at: new Date() })
            await QcJobRun.updateOne({ _id: run._id }, { $inc: { [status === 'DONE' ? 'done' : 'failed']: 1 } })
        },
        run.concurrency,
        () => stopping,
    )
    if (stopping) {
        log.warn({ job_run_id: run._id }, 'QC: stopped mid-run, will resume after restart')
        return
    }
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
}

// ปิดรอบเป็น FAILED สายที่ยังไม่ได้ตรวจเปลี่ยนเป็น CANCELLED (ไม่ค้างสถานะรอคิว/กำลังตรวจ)
const failRun = async (runId, reason) => {
    await QcJobRunCall.updateMany(
        { job_run_id: runId, status: { $in: ['QUEUED', 'RUNNING'] } },
        { $set: { status: 'CANCELLED', updated_at: new Date() } },
    )
    await QcJobRun.updateOne(
        { _id: runId },
        { $set: { status: 'FAILED', error: reason, finished_at: new Date(), ...(await countRunCalls(runId)) } },
    )
}

// ทำงานของรอบเบื้องหลัง (ไม่ await: งานอาจยาวเกินเวลาที่ proxy/Cloudflare รอได้)
const runInBackground = (run, task) => {
    currentRun = (async () => {
        try {
            await task()
        } catch (e) {
            log.error(e, 'QC: job failed')
            await failRun(run._id, e.message).catch((err) => log.error(err, 'QC: mark run failed'))
        } finally {
            running = false
            currentRun = null
        }
    })()
}

const ACTIVE = ['SAMPLING', 'RUNNING']

// เริ่มรอบตรวจแล้วคืนทันที (งานจริงทำต่อเบื้องหลัง) หน้าเว็บใช้ job_run id ไปถามความคืบหน้า
// options ที่ไม่ส่งมาใช้ค่าตั้งปัจจุบัน
const startQcJob = async (options = {}, trigger = 'RUN_TASK') => {
    if (stopping) return { started: false, stopping: true, run: null }
    if (running) {
        const current = await QcJobRun.findOne({ status: { $in: ACTIVE } }).sort({ started_at: -1 }).lean()
        return { started: false, run: current }
    }
    running = true
    try {
        const settings = getSettings()
        // ใช้ prompt/schema ชุดเดียวทั้งรอบ แม้มีคนแก้จากหน้าเว็บระหว่างตรวจ
        const { prompt, schema, version } = await savePromptVersion()
        const run = await QcJobRun.create({
            trigger,
            status: 'SAMPLING',
            options: {
                lookbackHours: options.lookbackHours ?? settings.lookbackHours,
                samplePercent: options.samplePercent ?? settings.samplePercent,
                minDurationSeconds: options.minDurationSeconds ?? settings.minDurationSeconds,
            },
            model: settings.model,
            temperature: settings.temperature,
            prompt_version: version,
            concurrency: settings.concurrency,
            max_retry: settings.maxRetry,
            started_at: new Date(),
        })
        const job = { ...run.toObject(), prompt, schema }
        runInBackground(job, async () => processCalls(job, await sampleCalls(job)))
        return { started: true, run: run.toObject() }
    } catch (e) {
        running = false
        throw e
    }
}

// ค่าที่รอบเดิมใช้ (prompt/schema จากสำเนาตามเวอร์ชัน) รอบเก่าที่ไม่ได้เก็บบางค่าใช้ค่าตั้งปัจจุบันแทน
const buildResumeJob = async (run) => {
    const bundle = await getPromptVersion(run.prompt_version)
    if (!bundle) throw new Error(`prompt version ${run.prompt_version} not found, cannot resume`)
    const settings = getSettings()
    return {
        ...run,
        prompt: bundle.prompt,
        schema: JSON.parse(bundle.schema),
        temperature: run.temperature ?? settings.temperature,
        concurrency: run.concurrency || settings.concurrency,
        max_retry: run.max_retry ?? settings.maxRetry,
    }
}

// ทำรอบที่ค้างจากการรันครั้งก่อนต่อ (server ดับหรือ deploy กลางรอบ)
// - ค้างตอนเลือกสาย: ลบสายที่ใส่ไปแล้วบางส่วน เลือกใหม่ด้วยช่วงเวลาเดิม (started_at เดิม)
// - ค้างตอนตรวจ: สายที่ค้าง "กำลังตรวจ" กลับไปรอคิว แล้วตรวจต่อเฉพาะสายที่ยังไม่เสร็จ
// - ทำต่อเกิน MAX_RESUME ครั้ง หรือไม่มีสำเนา prompt: ปิดรอบ สายที่เหลือเป็น CANCELLED
const recoverRuns = async () => {
    const stale = await QcJobRun.find({ status: { $in: ACTIVE } }).sort({ started_at: -1 }).lean()
    if (!stale.length) return
    const [latest, ...older] = stale
    // ปกติค้างได้แค่รอบเดียว ถ้ามีมากกว่านั้นทำต่อเฉพาะรอบล่าสุด
    for (const r of older) await failRun(r._id, 'server restarted')

    if ((latest.resume_count || 0) >= MAX_RESUME) {
        log.warn({ job_run_id: latest._id, resume_count: latest.resume_count }, 'QC: run resumed too many times, giving up')
        await failRun(latest._id, 'server restarted too many times')
        return
    }
    let job
    try {
        job = await buildResumeJob(latest)
    } catch (e) {
        log.warn({ job_run_id: latest._id, error: e.message }, 'QC: cannot resume run')
        await failRun(latest._id, 'server restarted')
        return
    }

    running = true
    await QcJobRun.updateOne({ _id: latest._id }, { $inc: { resume_count: 1 }, $set: { resumed_at: new Date() } })
    log.warn({ job_run_id: latest._id, status: latest.status }, 'QC: resuming unfinished run')

    runInBackground(job, async () => {
        if (latest.status === 'SAMPLING') {
            await QcJobRunCall.deleteMany({ job_run_id: latest._id })
            await processCalls(job, await sampleCalls(job))
            return
        }
        await QcJobRunCall.updateMany(
            { job_run_id: latest._id, status: 'RUNNING' },
            { $set: { status: 'QUEUED', updated_at: new Date() }, $unset: { worker: '', started_at: '' } },
        )
        const queued = await QcJobRunCall.find({ job_run_id: latest._id, status: 'QUEUED' }, { session_id: 1 })
            .sort({ _id: 1 })
            .lean()
        const sessions = await loadSessionsByIds(queued.map((c) => c.session_id))
        const byId = new Map(sessions.map((s) => [String(s._id), s]))
        // session ที่หายไปจาก DB แล้ว ตรวจไม่ได้
        const missing = queued.filter((c) => !byId.has(String(c.session_id)))
        if (missing.length) {
            await QcJobRunCall.updateMany(
                { job_run_id: latest._id, _id: { $in: missing.map((c) => c._id) } },
                { $set: { status: 'CANCELLED', updated_at: new Date() } },
            )
        }
        const todo = queued.map((c) => byId.get(String(c.session_id))).filter(Boolean)
        log.info({ job_run_id: latest._id, remaining: todo.length }, 'QC: resumed run')
        await processCalls(job, todo)
    })
}

// ปิดระบบ: หยุดตั้งเวลาและหยุดหยิบสายใหม่ รอสายที่กำลังตรวจให้จบไม่เกิน graceMs
// สายที่ยังไม่จบทันเวลาค้างเป็น RUNNING แล้ว recoverRuns เอากลับไปรอคิวตอนเริ่มใหม่
const shutdown = async (graceMs = 25000) => {
    stopping = true
    if (scheduledTask) {
        scheduledTask.destroy()
        scheduledTask = null
    }
    if (!currentRun) return
    log.warn({ graceMs }, 'QC: shutting down, waiting for calls in progress')
    let timer
    await Promise.race([currentRun, new Promise((r) => (timer = setTimeout(r, graceMs)))])
    clearTimeout(timer)
}

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
    await recoverRuns()
    applySchedule()
    onChange(applySchedule)
}

module.exports = { start, shutdown, startQcJob, evaluateSession, evaluateWithRetry, runPool }
