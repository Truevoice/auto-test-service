const { FIELD_IDS, getSettings } = require('./qc_settings')
const { FILE_IDS, getFile } = require('./qc_files')

// ค่าตั้งของงานตรวจอัตโนมัติที่แสดงในหน้า "ตั้งค่าระบบ" ของ UI
// ค่าตั้งและไฟล์ prompt/schema เก็บใน DB แก้จากหน้าเว็บได้ (editable) ส่วน region อ่านจาก env อย่างเดียว
// ห้ามใส่ค่าที่เกี่ยวกับสิทธิ์/บัญชี (token, รหัส DB, service account, GCP project) และไม่บอกที่มาของค่า
// ส่งออกด้วย id กลาง ไม่ส่งชื่อตัวแปร env
const GROUPS = [
    {
        id: 'job',
        items: [
            'jobEnabled',
            'schedule',
            'lookbackHours',
            'samplePercent',
            'minDurationSeconds',
            'concurrency',
            'maxRetry',
            'promptFile',
            'schemaFile',
        ],
    },
    { id: 'gemini', items: ['region', 'model', 'temperature'] },
]

const region = () => String(process.env.GCP_LOCATION ?? '').trim() || 'global'

const getQcConfig = () => {
    const settings = getSettings()
    return {
        groups: GROUPS.map((group) => ({
            id: group.id,
            items: group.items.map((id) => {
                if (FIELD_IDS.includes(id)) return { id, value: settings[id], editable: true }
                if (FILE_IDS.includes(id)) {
                    // ไฟล์: บอกว่ามีเนื้อหาไหมและแก้ล่าสุดเมื่อไร เนื้อหาดูผ่าน GET /qc/config/files/:id
                    const file = getFile(id)
                    return { id, value: file?.updated_at ?? null, updated_by: file?.updated_by?.name || null, exists: Boolean(file), editable: true }
                }
                return { id, value: region() }
            }),
        })),
    }
}

module.exports = { getQcConfig }
