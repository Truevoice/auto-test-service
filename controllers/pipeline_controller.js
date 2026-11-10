const Joi = require('joi')
const pipelineJob = require('../services/pipeline/pipeline_job')
const pipelineSettings = require('../services/pipeline/pipeline_settings')
const { isConfigured } = require('../db/source_mongo')
const { getRun, getActiveRun, listRuns, averageBatchMs, toRunView } = require('../services/pipeline/pipeline_run_service')
const audit = require('../services/audit/audit_service')
const log = require('../utils/log')

// ช่วงที่ดึงได้ต่อรอบ (กันกดดึงทั้งฐานโดยไม่ตั้งใจ)
const MAX_RANGE_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

const rangeSchema = {
  from: Joi.date().iso().required(),
  to: Joi.date()
    .iso()
    .greater(Joi.ref('from'))
    .default(() => new Date()),
}

const checkRange = (value) => {
  if (value.to - value.from > MAX_RANGE_DAYS * DAY_MS) return `range must be at most ${MAX_RANGE_DAYS} days`
  return null
}

const countSchema = Joi.object(rangeSchema)
const runSchema = Joi.object({
  ...rangeSchema,
  limit: Joi.number().integer().min(1).max(pipelineSettings.MAX_BATCH_LIMIT),
})
const listSchema = Joi.object({
  before: Joi.date().iso(),
  limit: Joi.number().integer().min(1).max(100).default(30),
})

const byUser = (req) => (req.user ? { email: req.user.email, name: req.user.name } : null)

// ข้อความ error ที่หน้าเว็บเห็น ไม่บอก host/ค่าเชื่อมต่อของฐานต้นทาง
const sourceError = (res, e) => {
  if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ message: 'Source database is not configured', code: 'NOT_CONFIGURED' })
  if (e.code === 'SAME_DATABASE') return res.status(503).json({ message: 'Source database is not configured', code: 'NOT_CONFIGURED' })
  log.error({ code: e.code, error: e.message }, 'Pipeline: source database error')
  return res.status(502).json({ message: 'Cannot reach the source database', code: 'SOURCE_UNREACHABLE' })
}

// ค่าตั้งและข้อมูลที่หน้าเว็บใช้คำนวณ ไม่มีค่าเชื่อมต่อใดๆ
const configView = async () => ({
  configured: isConfigured(),
  ...pipelineSettings.getSettings(),
  intervalOptions: pipelineSettings.INTERVAL_HOURS,
  maxBatchLimit: pipelineSettings.MAX_BATCH_LIMIT,
  maxRangeDays: MAX_RANGE_DAYS,
  ...(await averageBatchMs()),
})

class pipelineController {
  async config(req, res) {
    try {
      res.json({ message: 'Success', data: { ...(await configView()), active: await getActiveRun() } })
    } catch (e) {
      log.error({ error: 'Controller: pipelineController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  async updateConfig(req, res) {
    try {
      const patch = pipelineSettings.validateSettings(req.body)
      const before = pipelineSettings.getSettings()
      await pipelineSettings.updateSettings(patch, byUser(req))
      const changes = Object.fromEntries(
        Object.keys(patch)
          .filter((k) => before[k] !== patch[k])
          .map((k) => [k, { from: before[k], to: patch[k] }]),
      )
      if (Object.keys(changes).length) {
        await audit.record(req, 'PIPELINE_CONFIG_UPDATE', { target: 'pipeline', detail: { changes } })
      }
      res.json({ message: 'Success', data: await configView() })
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ message: e.message })
      log.error({ error: 'Controller: pipelineController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  // นับจำนวน session ที่ต้นทางในช่วงเวลา (ก่อนเริ่มดึง)
  async count(req, res) {
    const { error, value } = countSchema.validate(req.body || {})
    if (error) return res.status(400).json({ message: error.details[0].message })
    const rangeError = checkRange(value)
    if (rangeError) return res.status(400).json({ message: rangeError })
    try {
      const total = await pipelineJob.countRange(value)
      res.json({ message: 'Success', data: { total, from: value.from, to: value.to } })
    } catch (e) {
      sourceError(res, e)
    }
  }

  // เริ่มดึงแล้วตอบทันที (202) หน้าเว็บถามความคืบหน้าต่อที่ GET /qc/pipeline/runs/:id
  async run(req, res) {
    const { error, value } = runSchema.validate(req.body || {})
    if (error) return res.status(400).json({ message: error.details[0].message })
    const rangeError = checkRange(value)
    if (rangeError) return res.status(400).json({ message: rangeError })
    if (!isConfigured()) return res.status(503).json({ message: 'Source database is not configured', code: 'NOT_CONFIGURED' })
    try {
      const { started, stopping, run } = await pipelineJob.startPipeline(value, 'MANUAL', byUser(req))
      if (stopping) return res.status(503).json({ message: 'Server is restarting, try again shortly' })
      if (!started) return res.status(409).json({ message: 'Pipeline already running', data: toRunView(run) })
      await audit.record(req, 'PIPELINE_START', {
        target: run._id,
        detail: { from: run.range_from, to: run.range_to, limit: run.limit },
      })
      res.status(202).json({ message: 'Accepted', data: toRunView(run) })
    } catch (e) {
      log.error({ error: 'Controller: pipelineController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  async runs(req, res) {
    const { error, value } = listSchema.validate(req.query || {})
    if (error) return res.status(400).json({ message: error.details[0].message })
    try {
      res.json({ message: 'Success', data: await listRuns(value) })
    } catch (e) {
      log.error({ error: 'Controller: pipelineController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  async runDetail(req, res) {
    try {
      const run = await getRun(req.params.id)
      if (!run) return res.status(404).json({ message: 'Data Not Found' })
      res.json({ message: 'Success', data: run })
    } catch {
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }
}

module.exports = pipelineController
