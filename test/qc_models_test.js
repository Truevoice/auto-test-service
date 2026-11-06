const { expect } = require('chai')
const { toModelList } = require('../services/qc/qc_models')

// รายชื่อจริงที่ Vertex AI คืนมา (บางส่วน)
const VERTEX_NAMES = [
    'gemini-1.5-pro-002',
    'gemini-2.5-flash-preview-04-17',
    'gemini-2.5-pro-exp-03-25',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash-tts',
    'gemini-live-2.5-flash-native-audio',
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-image',
    'gemini-embedding-2',
    'gemini-3.1-flash-lite',
    'gemini-3.5-transcribe',
    'gemini-3.8-flash',
    'gemini-3.8-flash-lite-tts',
]

describe('qc models', () => {
    const ids = toModelList(VERTEX_NAMES).map((m) => m.id)

    it('keeps only models usable for QC (no tts, image, embedding, live, transcribe, dated previews, < 2.5)', () => {
        expect(ids).to.have.members([
            'gemini-3.8-flash',
            'gemini-3.1-flash-lite',
            'gemini-3.1-pro-preview',
            'gemini-3-flash-preview',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
        ])
    })

    it('sorts newest first, then pro / flash / flash-lite, previews after releases', () => {
        expect(ids).to.deep.equal([
            'gemini-3.8-flash',
            'gemini-3.1-flash-lite',
            'gemini-3.1-pro-preview',
            'gemini-3-flash-preview',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
        ])
    })

    it('labels family and preview', () => {
        const pro = toModelList(['gemini-3.1-pro-preview'])[0]
        expect(pro).to.include({ family: 'pro', preview: true, version: 3.1 })
    })
})
