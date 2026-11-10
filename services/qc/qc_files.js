const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const QcSetting = require('../../models/qc_setting_model')
const QcPromptVersion = require('../../models/qc_prompt_version_model')
const log = require('../../utils/log')

const ROOT = path.join(__dirname, '../..')
const MAX_LENGTH = 200000

// ไฟล์คำสั่ง (prompt) และรูปแบบผลตรวจ (schema) เก็บใน DB แก้จากหน้าเว็บได้
// DB ยังไม่มี: อ่านจากไฟล์ตาม env แล้วเขียนลง DB ครั้งถัดไปใช้ค่าใน DB
const FILES = {
    promptFile: { env: 'QC_PROMPT_FILE', fallback: 'prompts/qc_judge.txt', json: false },
    schemaFile: { env: 'QC_SCHEMA_FILE', fallback: 'prompts/qc_result.schema.json', json: true },
}

const docId = (id) => `file:${id}`
let cache = {}

const sourcePath = (id) => {
    const { env, fallback } = FILES[id]
    const relative = String(process.env[env] ?? '').trim() || fallback
    const full = path.resolve(ROOT, relative)
    // กันอ่านไฟล์นอกโปรเจค ถ้า env ชี้ออกไปข้างนอก
    return full.startsWith(ROOT + path.sep) ? full : null
}

const readSourceFile = (id) => {
    const full = sourcePath(id)
    if (!full) return null
    try {
        return fs.readFileSync(full, 'utf8')
    } catch {
        return null
    }
}

// ตรวจเนื้อหาก่อนบันทึก: ห้ามว่าง, ไม่ยาวเกิน, schema ต้องเป็น JSON object
const validateFile = (id, content) => {
    const fail = (message) => {
        const e = new Error(message)
        e.status = 400
        throw e
    }
    if (!FILES[id]) fail('unknown file')
    if (typeof content !== 'string' || !content.trim()) fail('content must not be empty')
    if (content.length > MAX_LENGTH) fail(`content must be at most ${MAX_LENGTH} characters`)
    if (FILES[id].json) {
        let parsed
        try {
            parsed = JSON.parse(content)
        } catch (e) {
            fail(`schema is not valid JSON: ${e.message}`)
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('schema must be a JSON object')
    }
    return content
}

const loadFiles = async () => {
    const docs = await QcSetting.find({ _id: { $in: Object.keys(FILES).map(docId) } }).lean()
    const byId = Object.fromEntries(docs.map((d) => [d._id, d]))
    cache = {}
    for (const id of Object.keys(FILES)) {
        let doc = byId[docId(id)]
        if (!doc?.content) {
            const content = readSourceFile(id)
            if (content == null) {
                log.warn({ file: id }, 'QC: file not in DB and source file not found')
                continue
            }
            doc = await QcSetting.findByIdAndUpdate(docId(id), { $set: { content } }, { upsert: true, new: true, lean: true })
            log.info({ file: id }, 'QC: file seeded from disk')
        }
        cache[id] = { content: doc.content, updated_at: doc.updated_at, updated_by: doc.updated_by || null }
    }
    // ชุดปัจจุบันมีสำเนาเสมอ (รอบเก่าที่ใช้ชุดเดียวกับตอนนี้ก็เปิดดูได้)
    if (cache.promptFile && cache.schemaFile) await savePromptVersion().catch((e) => log.warn(e, 'QC: save prompt version'))
}

const getFile = (id) => (FILES[id] && cache[id] ? { id, ...cache[id] } : null)

// updatedBy = { email, name } ของคนที่แก้จากหน้าเว็บ
const updateFile = async (id, content, updatedBy = null) => {
    validateFile(id, content)
    const doc = await QcSetting.findByIdAndUpdate(
        docId(id),
        { $set: { content, updated_by: updatedBy } },
        { upsert: true, new: true, lean: true },
    )
    cache[id] = { content: doc.content, updated_at: doc.updated_at, updated_by: doc.updated_by || null }
    log.info({ file: id, length: content.length }, 'QC: file updated')
    return getFile(id)
}

// ชุด prompt + schema ที่ใช้ตรวจ พร้อมเวอร์ชัน (hash) ไว้บอกว่าผลตรวจมาจาก prompt ไหน
const getPromptBundle = () => {
    const prompt = cache.promptFile?.content
    const schemaText = cache.schemaFile?.content
    if (!prompt || !schemaText) throw new Error('QC prompt or schema is not configured')
    const version = crypto.createHash('sha1').update(prompt).update('\0').update(schemaText).digest('hex').slice(0, 10)
    return { prompt, schema: JSON.parse(schemaText), schemaText, version }
}

// เก็บสำเนา prompt + schema ของเวอร์ชันนี้ (ครั้งแรกที่เจอเท่านั้น) ให้รอบตรวจเปิดดูย้อนหลังได้
const savePromptVersion = async (bundle = getPromptBundle()) => {
    await QcPromptVersion.updateOne(
        { _id: bundle.version },
        { $setOnInsert: { prompt: bundle.prompt, schema: bundle.schemaText } },
        { upsert: true },
    )
    return bundle
}

// prompt + schema ของเวอร์ชันที่ระบุ (null ถ้าไม่มีสำเนา เช่นรอบที่รันก่อนมีการเก็บสำเนา)
const getPromptVersion = async (version) => {
    if (!/^[0-9a-f]{10}$/.test(String(version))) return null
    return QcPromptVersion.findById(String(version)).lean()
}

module.exports = {
    FILE_IDS: Object.keys(FILES),
    loadFiles,
    getFile,
    updateFile,
    validateFile,
    getPromptBundle,
    savePromptVersion,
    getPromptVersion,
}
