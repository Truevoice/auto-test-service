const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env') })
const { GoogleGenAI } = require('@google/genai')
const {
    SERVICE_ACCOUNT_FILE = 'service-account.json',
    GCP_PROJECT_ID,
    GCP_LOCATION = 'global',
    GEMINI_MODEL = 'gemini-2.5-flash',
    GEMINI_TEMPERATURE = '0',
    GEMINI_TIMEOUT_MS = '120000',
} = process.env

const ROOT = path.join(__dirname, '..')
const keyFile = path.join(ROOT, 'key', SERVICE_ACCOUNT_FILE)
let client = null

const getClient = () => {
    if (!client) {
        const project = GCP_PROJECT_ID || JSON.parse(fs.readFileSync(keyFile, 'utf8')).project_id
        client = new GoogleGenAI({
            vertexai: true,
            project,
            location: GCP_LOCATION,
            googleAuthOptions: { keyFile, scopes: ['https://www.googleapis.com/auth/cloud-platform'] },
            // SDK ไม่มี timeout เป็นค่าเริ่มต้น request ที่ค้างจะค้างไปตลอดจนรอบตรวจเกินชั่วโมง
            // ไม่เปิด retryOptions ของ SDK เพราะ retry ทำที่ evaluateWithRetry แล้ว (กันลองซ้ำซ้อนกัน)
            httpOptions: { timeout: Number(GEMINI_TIMEOUT_MS) },
        })
    }
    return client
}

const nowText = () =>
    new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok', hour12: false }) + ' (Asia/Bangkok)'

// รายการ turn ลูกค้าที่โค้ดนับให้ (ไม่มีบรรทัด Bot) ให้ Gemini ใช้เป็นคำตอบของการนับ turn
const customerTurnsText = (customerTurns = []) =>
    [
        `Customer turns to evaluate (authoritative, computed by the system; Bot lines are NOT turns). Total = ${customerTurns.length}`,
        ...customerTurns.map((t) => `[Turn ${t.turn_id}: ${t.speaker} - ${t.text}]`),
    ].join('\n')

// ส่ง transcript + ไฟล์เสียงใน GCS ให้ Gemini ประเมิน แล้วคืน JSON ตาม schema
// prompt/schema/model/temperature มาจากค่าตั้งใน DB ที่แก้จากหน้าเว็บได้ (model/temperature ไม่ส่งมาใช้ค่าจาก env)
const evaluate = async ({
    transcript,
    customerTurns,
    audioUri,
    prompt,
    schema,
    mimeType = 'audio/wav',
    model = GEMINI_MODEL,
    temperature = Number(GEMINI_TEMPERATURE),
}) => {
    if (!prompt || !schema) throw new Error('gemini_api: prompt and schema are required')
    const text = [`Current datetime: ${nowText()}`, `Text transcript:\n${transcript}`]
    if (customerTurns) text.push(customerTurnsText(customerTurns))
    const response = await getClient().models.generateContent({
        model,
        contents: [
            {
                role: 'user',
                parts: [
                    { text: text.join('\n\n') },
                    { fileData: { fileUri: audioUri, mimeType } },
                ],
            },
        ],
        config: {
            systemInstruction: prompt,
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            temperature,
        },
    })
    if (!response.text) {
        throw new Error(`gemini_api: empty response (finishReason=${response.candidates?.[0]?.finishReason})`)
    }
    return { result: JSON.parse(response.text), usage: toUsage(response.usageMetadata) }
}

// จำนวน token จาก Gemini แยกตามชนิด input (AUDIO ใช้ยืนยันว่าโมเดลได้รับไฟล์เสียงจริง)
const toUsage = (meta = {}) => {
    const byModality = (details = []) =>
        Object.fromEntries(details.map((d) => [String(d.modality).toLowerCase(), d.tokenCount || 0]))
    const prompt = byModality(meta.promptTokensDetails)
    return {
        prompt_tokens: meta.promptTokenCount || 0,
        audio_tokens: prompt.audio || 0,
        text_tokens: prompt.text || 0,
        output_tokens: meta.candidatesTokenCount || 0,
        thoughts_tokens: meta.thoughtsTokenCount || 0,
        total_tokens: meta.totalTokenCount || 0,
    }
}

// รายชื่อโมเดลพื้นฐานที่ Google เปิดให้ใช้ใน Vertex AI ตอนนี้ (ชื่อสั้น เช่น gemini-2.5-flash)
const listModels = async () => {
    const names = []
    const pager = await getClient().models.list({ config: { queryBase: true, pageSize: 100 } })
    for await (const m of pager) names.push(String(m.name || '').split('/').pop())
    return names.filter(Boolean)
}

// เรียกโมเดลด้วยข้อความสั้นๆ + JSON schema เล็กๆ เพื่อเช็กว่าใช้กับงานตรวจได้จริงก่อนบันทึก (ใช้ token น้อยมาก)
const probeModel = async (model) => {
    const response = await getClient().models.generateContent({
        model,
        contents: 'Reply with {"ok": true}.',
        config: {
            responseMimeType: 'application/json',
            responseJsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
            temperature: 0,
            // โมเดลที่คิดก่อนตอบ (thinking) ใช้ token ส่วนนี้ด้วย ตั้งน้อยไปจะได้คำตอบว่าง
            maxOutputTokens: 2048,
        },
    })
    JSON.parse(response.text || '')
}

module.exports = { evaluate, listModels, probeModel, model: GEMINI_MODEL }
