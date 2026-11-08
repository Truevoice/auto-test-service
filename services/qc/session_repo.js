const mongoose = require('mongoose')

// field ที่ใช้สร้าง transcript และบันทึกผล (ใช้ทั้งตอนสุ่มและตอนโหลดสายของรอบที่ทำต่อ)
const PROJECTION = {
    bot_session_id: 1,
    call_recording_url: 1,
    'bot_session.conversations': 1,
    // เวลาและข้อความต่อประโยค ใช้ใส่ [mm:ss] ใน transcript
    'conversations.conversation_id': 1,
    'conversations.sender': 1,
    'conversations.message.utterance': 1,
    'conversations.created_at': 1,
    'conversations.listened_at': 1,
    'payload.ani': 1,
    created_at: 1,
    duration: 1,
}

const { QC_LOOKBACK_HOURS = '1', QC_SAMPLE_PERCENT = '10', QC_MIN_DURATION_SECONDS = '0' } = process.env

// สุ่ม session ที่จบแล้วย้อนหลัง N ชั่วโมง และยาวอย่างน้อย minDurationSeconds ตาม % ที่กำหนด
// (count 1 ครั้ง + $sample ใน aggregate)
const sampleEndedSessions = async ({
    lookbackHours = Number(QC_LOOKBACK_HOURS),
    samplePercent = Number(QC_SAMPLE_PERCENT),
    minDurationSeconds = Number(QC_MIN_DURATION_SECONDS),
    now = new Date(),
} = {}) => {
    const sessions = mongoose.connection.db.collection('sessions')
    const match = {
        created_at: { $gte: new Date(now.getTime() - lookbackHours * 60 * 60 * 1000) },
        is_end_session: true,
        call_recording_url: { $nin: [null, ''] },
    }
    if (minDurationSeconds > 0) match.duration = { $gte: minDurationSeconds }

    const total = await sessions.countDocuments(match)
    const size = Math.ceil((total * samplePercent) / 100)
    if (size === 0) return { total, docs: [] }

    const docs = await sessions
        .aggregate(
            [
                { $match: match },
                { $sample: { size } },
                {
                    $project: PROJECTION,
                },
            ],
            { allowDiskUse: true },
        )
        .toArray()

    return { total, docs }
}

// โหลด session ตาม _id (ใช้ index _id) สำหรับรอบที่ทำต่อหลังระบบรีสตาร์ท
const loadSessionsByIds = async (ids) => {
    if (!ids.length) return []
    return mongoose.connection.db
        .collection('sessions')
        .find({ _id: { $in: ids } }, { projection: PROJECTION })
        .toArray()
}

module.exports = { sampleEndedSessions, loadSessionsByIds }
