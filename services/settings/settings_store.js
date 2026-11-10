const Joi = require('joi')
const QcSetting = require('../../models/qc_setting_model')
const log = require('../../utils/log')

// ค่าตั้งที่แก้จากหน้าเว็บได้ เก็บเป็นเอกสารเดียวต่อชุดใน qc_setting (_id = id)
// ลำดับความสำคัญ: DB > env > ค่าเริ่มต้น ตอนเริ่มระบบค่าที่ DB ยังไม่มีจะอ่านจาก env แล้วเขียนลง DB
// fields: [{ id, env, fallback, type: 'boolean' | 'number' | 'string', rule: Joi }]
const createSettingsStore = ({ id, fields, label = id }) => {
    const fieldIds = fields.map((f) => f.id)
    // ไม่รับ key ที่ไม่รู้จัก
    const updateSchema = Joi.object(Object.fromEntries(fields.map((f) => [f.id, f.rule]))).min(1)

    let overrides = {}
    const listeners = []

    const envValue = (field) => {
        const raw = String(process.env[field.env] ?? '').trim()
        const value = raw === '' ? field.fallback : raw
        if (field.type === 'boolean') return value === 'true'
        if (field.type === 'number') return Number(value)
        return value
    }

    const pickKnown = (values = {}) => Object.fromEntries(Object.entries(values).filter(([k]) => fieldIds.includes(k)))

    // ค่าที่ใช้อยู่ตอนนี้ (เรียกได้ทุกที่ ไม่ต้องรอ DB)
    const getSettings = () =>
        Object.fromEntries(fields.map((f) => [f.id, Object.hasOwn(overrides, f.id) ? overrides[f.id] : envValue(f)]))

    // ค่าที่ DB ยังไม่มี: เอาจาก env/ค่าเริ่มต้น (ใช้ตอน seed ลง DB)
    const missingFromEnv = (values = {}) =>
        Object.fromEntries(fields.filter((f) => !Object.hasOwn(values, f.id)).map((f) => [f.id, envValue(f)]))

    const loadSettings = async () => {
        const doc = await QcSetting.findById(id).lean()
        const seed = missingFromEnv(doc?.values)
        if (Object.keys(seed).length) {
            const $set = Object.fromEntries(Object.entries(seed).map(([k, v]) => [`values.${k}`, v]))
            const saved = await QcSetting.findByIdAndUpdate(id, { $set }, { upsert: true, new: true, lean: true })
            log.info({ seeded: Object.keys(seed) }, `${label}: settings seeded from env`)
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
        const doc = await QcSetting.findByIdAndUpdate(id, { $set }, { upsert: true, new: true, lean: true })
        overrides = pickKnown(doc.values)
        const settings = getSettings()
        log.info({ changed: Object.keys(value) }, `${label}: settings updated`)
        for (const fn of listeners) {
            try {
                fn(settings)
            } catch (e) {
                log.error(e, `${label}: settings listener failed`)
            }
        }
        return settings
    }

    const onChange = (fn) => listeners.push(fn)

    return { FIELD_IDS: fieldIds, getSettings, loadSettings, missingFromEnv, validateSettings, updateSettings, onChange }
}

module.exports = { createSettingsStore }
