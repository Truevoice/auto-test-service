const Joi = require('joi')
const { createSettingsStore } = require('../settings/settings_store')

// ชั่วโมงที่หาร 24 ลงตัว รอบตั้งเวลาจะห่างเท่ากันแม้ข้ามเที่ยงคืน (cron 0 */N * * *)
const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24]
const MAX_BATCH_LIMIT = 1000

const FIELDS = [
    { id: 'enabled', env: 'PIPELINE_JOB_ENABLED', fallback: 'false', type: 'boolean', rule: Joi.boolean() },
    {
        id: 'intervalHours',
        env: 'PIPELINE_INTERVAL_HOURS',
        fallback: '1',
        type: 'number',
        rule: Joi.number()
            .valid(...INTERVAL_HOURS)
            .messages({ 'any.only': `"intervalHours" must be one of ${INTERVAL_HOURS.join(', ')}` }),
    },
    {
        id: 'batchLimit',
        env: 'PIPELINE_BATCH_LIMIT',
        fallback: '50',
        type: 'number',
        rule: Joi.number().integer().min(1).max(MAX_BATCH_LIMIT),
    },
]

const store = createSettingsStore({ id: 'pipeline', fields: FIELDS, label: 'Pipeline' })

// cron ของรอบตั้งเวลา: ทุก N ชั่วโมงตรงนาทีที่ 0
const scheduleOf = (intervalHours) => (intervalHours >= 24 ? '0 0 * * *' : `0 */${intervalHours} * * *`)

module.exports = { ...store, INTERVAL_HOURS, MAX_BATCH_LIMIT, scheduleOf }
