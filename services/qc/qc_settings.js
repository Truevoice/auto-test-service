const Joi = require('joi')
const cron = require('node-cron')
const QcSetting = require('../../models/qc_setting_model')
const log = require('../../utils/log')

const SETTINGS_ID = 'qc'

const cronExpression = Joi.string()
    .trim()
    .custom((value, helpers) => (cron.validate(value) ? value : helpers.error('any.invalid')))
    .messages({ 'any.invalid': '"schedule" must be a valid cron expression' })

// ค่าที่แก้จากหน้าเว็บได้: ลำดับความสำคัญ DB > env > ค่าเริ่มต้น
// default ต้องตรงกับที่โค้ดเคยใช้ตอนอ่านจาก env โดยตรง
const FIELDS = [
    { id: 'jobEnabled', env: 'QC_JOB_ENABLED', fallback: 'false', type: 'boolean', rule: Joi.boolean() },
    { id: 'schedule', env: 'QC_JOB_CRON', fallback: '0 * * * *', type: 'string', rule: cronExpression },
    { id: 'lookbackHours', env: 'QC_LOOKBACK_HOURS', fallback: '1', type: 'number', rule: Joi.number().min(1).max(720) },
    { id: 'samplePercent', env: 'QC_SAMPLE_PERCENT', fallback: '10', type: 'number', rule: Joi.number().greater(0).max(100) },
    {
        id: 'minDurationSeconds',
        env: 'QC_MIN_DURATION_SECONDS',
        fallback: '0',
        type: 'number',
        rule: Joi.number().integer().min(0).max(3600),
    },
    { id: 'concurrency', env: 'QC_CONCURRENCY', fallback: '3', type: 'number', rule: Joi.number().integer().min(1).max(20) },
    { id: 'maxRetry', env: 'QC_MAX_RETRY', fallback: '2', type: 'number', rule: Joi.number().integer().min(0).max(5) },
    {
        id: 'model',
        env: 'GEMINI_MODEL',
        fallback: 'gemini-2.5-flash',
        type: 'string',
        rule: Joi.string()
            .trim()
            .pattern(/^gemini-[\w.-]+$/)
            .messages({ 'string.pattern.base': '"model" must be a Gemini model name such as gemini-2.5-flash' }),
    },
    { id: 'temperature', env: 'GEMINI_TEMPERATURE', fallback: '0', type: 'number', rule: Joi.number().min(0).max(2) },
]

const FIELD_IDS = FIELDS.map((f) => f.id)
// ไม่มี key ที่ไม่รู้จัก (ค่าอื่นเช่นไฟล์ prompt, region แก้จากหน้าเว็บไม่ได้)
const updateSchema = Joi.object(Object.fromEntries(FIELDS.map((f) => [f.id, f.rule]))).min(1)

let overrides = {}
const listeners = []

const envValue = (field) => {
    const raw = String(process.env[field.env] ?? '').trim()
    const value = raw === '' ? field.fallback : raw
    if (field.type === 'boolean') return value === 'true'
    if (field.type === 'number') return Number(value)
    return value
}

const pickKnown = (values = {}) => Object.fromEntries(Object.entries(values).filter(([k]) => FIELD_IDS.includes(k)))

// ค่าที่ใช้อยู่ตอนนี้ (เรียกได้ทุกที่ ไม่ต้องรอ DB)
const getSettings = () =>
    Object.fromEntries(FIELDS.map((f) => [f.id, Object.hasOwn(overrides, f.id) ? overrides[f.id] : envValue(f)]))

// ค่าที่ DB ยังไม่มี: เอาจาก env/ค่าเริ่มต้น (ใช้ตอน seed ลง DB)
const missingFromEnv = (values = {}) =>
    Object.fromEntries(FIELDS.filter((f) => !Object.hasOwn(values, f.id)).map((f) => [f.id, envValue(f)]))

// โหลดค่าตั้งจาก DB ตอนเริ่ม ค่าไหน DB ยังไม่มีให้อ่านจาก env แล้วเขียนลง DB
// ครั้งถัดไป DB จะมีค่าครบ และหน้าเว็บเป็นที่แก้ค่าที่เดียว (แก้ env ทีหลังไม่มีผลกับค่าที่อยู่ใน DB แล้ว)
const loadSettings = async () => {
    const doc = await QcSetting.findById(SETTINGS_ID).lean()
    const seed = missingFromEnv(doc?.values)
    if (Object.keys(seed).length) {
        const $set = Object.fromEntries(Object.entries(seed).map(([k, v]) => [`values.${k}`, v]))
        const saved = await QcSetting.findByIdAndUpdate(SETTINGS_ID, { $set }, { upsert: true, new: true, lean: true })
        log.info({ seeded: Object.keys(seed) }, 'QC: settings seeded from env')
        overrides = pickKnown(saved.values)
    } else {
        overrides = pickKnown(doc.values)
    }
    return getSettings()
}

const validateSettings = (patch) => {
    const { error, value } = updateSchema.validate(patch ?? {})
    if (error) {
        const e = new Error(error.details[0].message)
        e.status = 400
        throw e
    }
    return value
}

// updatedBy = { email, name } ของคนที่แก้จากหน้าเว็บ
const updateSettings = async (patch, updatedBy = null) => {
    const value = validateSettings(patch)
    const $set = Object.fromEntries(Object.entries(value).map(([k, v]) => [`values.${k}`, v]))
    $set.updated_by = updatedBy
    const doc = await QcSetting.findByIdAndUpdate(SETTINGS_ID, { $set }, { upsert: true, new: true, lean: true })
    overrides = pickKnown(doc.values)
    const settings = getSettings()
    log.info({ changed: Object.keys(value) }, 'QC: settings updated')
    for (const fn of listeners) {
        try {
            fn(settings)
        } catch (e) {
            log.error(e, 'QC: settings listener failed')
        }
    }
    return settings
}

const onChange = (fn) => listeners.push(fn)

module.exports = { FIELD_IDS, getSettings, loadSettings, missingFromEnv, validateSettings, updateSettings, onChange }
