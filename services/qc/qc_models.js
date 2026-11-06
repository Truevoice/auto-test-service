const gemini = require('../../api/gemini_api')
const log = require('../../utils/log')

const CACHE_MS = 6 * 60 * 60 * 1000

// ใช้เมื่อถามรายชื่อจาก Google ไม่ได้ (เน็ตหรือสิทธิ์มีปัญหา) หน้าเว็บยังเลือกโมเดลหลักได้
const FALLBACK = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']

// งานตรวจต้องส่งเสียง + ข้อความ แล้วได้ JSON กลับ: ตัดโมเดลเฉพาะทางที่ใช้กับงานนี้ไม่ได้
const NOT_FOR_QC = /tts|image|embedding|live|transcribe|translate|banana|native-audio|omni|-exp-|-\d{2}-\d{2}$/
// รุ่นเก่ากว่า 2.5 ไม่รองรับ responseJsonSchema แบบที่ใช้อยู่
const MIN_VERSION = 2.5

const parse = (id) => {
    const m = id.match(/^gemini-(\d+(?:\.\d+)?)-?(.*)$/)
    const version = m ? Number(m[1]) : null
    const rest = m ? m[2] : id.replace(/^gemini-/, '')
    const family = /flash-lite/.test(rest) ? 'flash-lite' : /pro/.test(rest) ? 'pro' : /flash/.test(rest) ? 'flash' : 'other'
    return { id, version, family, preview: /preview/.test(rest) }
}

const FAMILY_ORDER = { pro: 0, flash: 1, 'flash-lite': 2, other: 3 }

// เรียงรุ่นใหม่ก่อน แล้ว pro / flash / flash-lite, รุ่นทดลอง (preview) ไว้หลังรุ่นจริงของเลขเดียวกัน
const toModelList = (names) =>
    [...new Set(names)]
        .filter((id) => id.startsWith('gemini-') && !NOT_FOR_QC.test(id))
        .map(parse)
        .filter((m) => m.version == null || m.version >= MIN_VERSION)
        .sort(
            (a, b) =>
                (b.version ?? 0) - (a.version ?? 0) ||
                a.preview - b.preview ||
                FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family] ||
                a.id.localeCompare(b.id),
        )

let cache = null

const getModels = async () => {
    if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.result
    try {
        const models = toModelList(await gemini.listModels())
        if (!models.length) throw new Error('no usable models in list')
        cache = { fetchedAt: Date.now(), result: { source: 'google', fetched_at: new Date(), models } }
        return cache.result
    } catch (e) {
        log.warn({ error: e.message }, 'QC: list Gemini models failed, using fallback list')
        return { source: 'fallback', fetched_at: null, models: toModelList(FALLBACK) }
    }
}

module.exports = { getModels, toModelList }
