const Joi = require('joi')
const cron = require('node-cron')
const { createSettingsStore } = require('../settings/settings_store')

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

const store = createSettingsStore({ id: SETTINGS_ID, fields: FIELDS, label: 'QC' })

module.exports = store
