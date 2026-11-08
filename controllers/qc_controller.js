const Joi = require('joi')
const qcJob = require('../services/qc/qc_job')
const { listQcSessions, getQcSessionDetail } = require('../services/qc/qc_session_service')
const { getQcConfig } = require('../services/qc/qc_config')
const { getFile, updateFile, getPromptVersion } = require('../services/qc/qc_files')
const { getSettings, updateSettings, validateSettings } = require('../services/qc/qc_settings')
const { getModels } = require('../services/qc/qc_models')
const gemini = require('../api/gemini_api')
const { toRunView, getLatestRun, getRun, listRuns, listRunCalls } = require('../services/qc/qc_run_service')
const QcSession = require('../models/qc_session_model')
const log = require('../utils/log')

const listSchema = Joi.object({
  start: Joi.date().iso().required(),
  end: Joi.date().iso().min(Joi.ref('start')).default(() => new Date()),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid('DONE', 'FAILED'),
  problem: Joi.string()
    .valid('NEEDS_REVIEW', 'NONE', 'STT_ERROR', 'BOT_LOGIC_FAIL', 'NLU_MISCLASSIFICATION', 'POOR_UX', 'TTS_STREAMING_FAIL', 'HIGH_LATENCY')
    .allow(''),
})

// ไม่ส่งค่าไหนมา ใช้ค่าตั้งปัจจุบันของงานตรวจ
const runSchema = Joi.object({
  lookbackHours: Joi.number().min(1).max(720),
  samplePercent: Joi.number().greater(0).max(100),
  minDurationSeconds: Joi.number().integer().min(0).max(3600),
})

const runListSchema = Joi.object({
  before: Joi.date().iso(),
  limit: Joi.number().integer().min(1).max(100).default(30),
  hideEmpty: Joi.boolean().default(false),
})

const runCallsSchema = Joi.object({
  status: Joi.string().valid('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED'),
  after: Joi.string().hex().length(24),
  limit: Joi.number().integer().min(1).max(500).default(100),
  changed_since: Joi.date().iso(),
})

class qcController {
  // เริ่มรอบตรวจแล้วตอบทันที (202) หน้าเว็บถามความคืบหน้าต่อที่ GET /qc/runs/:id
  // ไม่รอจนตรวจเสร็จ เพราะรอบยาวเกินเวลาที่ Cloudflare/proxy รอได้
  async run(req, res) {
    const { error, value: options } = runSchema.validate(req.body || {})
    if (error) return res.status(400).json({ message: error.details[0].message })
    try {
      const { started, run } = await qcJob.startQcJob(options, 'RUN_TASK')
      if (!started) return res.status(409).json({ message: 'QC run already in progress', data: toRunView(run) })
      res.status(202).json({ message: 'Accepted', data: toRunView(run) })
    } catch (e) {
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  // รอบตรวจล่าสุด (กำลังทำหรือจบแล้ว) ใช้ตอนเปิดหน้า "สั่งตรวจทันที"
  async latestRun(req, res) {
    try {
      res.json({ message: 'Success', data: await getLatestRun() })
    } catch (e) {
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  // ประวัติรอบตรวจ ใหม่ก่อน (ไม่มีรายการสาย) สำหรับหน้า "รอบตรวจ"
  async runs(req, res) {
    const { error, value } = runListSchema.validate(req.query || {})
    if (error) return res.status(400).json({ message: error.details[0].message })
    try {
      res.json({ message: 'Success', data: await listRuns(value) })
    } catch (e) {
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  // ความคืบหน้าของรอบเดียว (หน้าเว็บถามทุกไม่กี่วินาทีระหว่างตรวจ)
  async runDetail(req, res) {
    try {
      const run = await getRun(req.params.id)
      if (!run) return res.status(404).json({ message: 'Data Not Found' })
      res.json({ message: 'Success', data: run })
    } catch (e) {
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  // สายในรอบตรวจ แบ่งชุดด้วย after (กรองตามสถานะได้)
  async runCalls(req, res) {
    const { error, value } = runCallsSchema.validate(req.query || {})
    if (error) return res.status(400).json({ message: error.details[0].message })
    try {
      const { changed_since: changedSince, ...rest } = value
      const data = await listRunCalls(req.params.id, { ...rest, changedSince })
      if (!data) return res.status(404).json({ message: 'Data Not Found' })
      res.json({ message: 'Success', data })
    } catch (e) {
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  // prompt + schema ของเวอร์ชันที่รอบตรวจใช้ (ดูย้อนหลังได้แม้แก้ prompt ไปแล้ว)
  async promptVersion(req, res) {
    try {
      const doc = await getPromptVersion(req.params.version)
      if (!doc) return res.status(404).json({ message: 'Data Not Found' })
      res.json({ message: 'Success', data: { version: doc._id, prompt: doc.prompt, schema: doc.schema, created_at: doc.created_at } })
    } catch (e) {
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  async list(req, res) {
    const { error, value } = listSchema.validate(req.body || {})
    if (error) return res.status(400).json({ message: error.details[0].message })
    try {
      const data = await listQcSessions(value)
      res.json({ message: 'Success', data })
    } catch (e) {
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  // สายเดียวสำหรับลิงก์แชร์ของหน้า UI
  async detail(req, res) {
    try {
      const doc = await getQcSessionDetail(String(req.params.bot_session_id))
      if (!doc) return res.status(404).json({ message: 'Data Not Found' })
      res.json({ message: 'Success', data: doc })
    } catch (e) {
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  // ค่าตั้งของงานตรวจ (ไม่มีค่าลับหรือข้อมูลบัญชี) สำหรับหน้า "ตั้งค่าระบบ"
  async config(req, res) {
    try {
      res.json({ message: 'Success', data: getQcConfig() })
    } catch (e) {
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  // แก้ค่าตั้งจากหน้าเว็บ ส่งมาเฉพาะค่าที่เปลี่ยน มีผลกับรอบตรวจถัดไป (cron ตั้งเวลาใหม่ทันที)
  async updateConfig(req, res) {
    try {
      const patch = validateSettings(req.body)
      // เปลี่ยนโมเดล: ลองเรียกจริงก่อน กันบันทึกโมเดลที่ใช้กับงานตรวจไม่ได้ (รอบตรวจถัดไปจะพังทั้งรอบ)
      if (patch.model && patch.model !== getSettings().model) {
        try {
          await gemini.probeModel(patch.model)
        } catch (e) {
          log.warn({ model: patch.model, status: e.status, error: e.message }, 'QC: model probe failed')
          return res.status(400).json({ message: `model "${patch.model}" cannot be used for QC right now` })
        }
      }
      await updateSettings(patch)
      res.json({ message: 'Success', data: getQcConfig() })
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ message: e.message })
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  // รายชื่อโมเดล Gemini ที่ Google เปิดให้ใช้ตอนนี้ (กรองเฉพาะที่ใช้กับงานตรวจได้) สำหรับช่องเลือกโมเดล
  async models(req, res) {
    try {
      res.json({ message: 'Success', data: await getModels() })
    } catch (e) {
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  // เนื้อหาไฟล์ prompt หรือ schema (id: promptFile | schemaFile)
  async configFile(req, res) {
    try {
      const file = getFile(req.params.id)
      if (!file) return res.status(404).json({ message: 'Data Not Found' })
      res.json({ message: 'Success', data: file })
    } catch (e) {
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  // แก้เนื้อหาไฟล์ prompt หรือ schema จากหน้าเว็บ { content } มีผลกับรอบตรวจถัดไป
  async updateConfigFile(req, res) {
    try {
      const file = await updateFile(req.params.id, req.body?.content)
      res.json({ message: 'Success', data: file })
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ message: e.message })
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  async result(req, res) {
    const { bot_session_id: botSessionId } = req.params
    try {
      const result = await QcSession.findOne({ bot_session_id: botSessionId }).select('-error').lean()
      if (!result) return res.status(404).json({ message: 'Data Not Found' })
      res.json({ message: 'Success', data: result })
    } catch (e) {
      log.error({ error: 'Controller: qcController ' + e?.message })
      res.status(500).json({ message: 'Internal Server Error' })
    }
  }
}

module.exports = qcController
