const { expect } = require('chai')
const { getSettings, validateSettings } = require('../services/qc/qc_settings')

const badRequest = (patch) => {
    try {
        validateSettings(patch)
    } catch (e) {
        return e
    }
    return null
}

describe('qc settings', () => {
    const saved = { ...process.env }
    afterEach(() => {
        process.env = { ...saved }
    })

    it('falls back to env, then to the code defaults, with typed values', () => {
        delete process.env.QC_SAMPLE_PERCENT
        process.env.QC_JOB_ENABLED = 'true'
        process.env.QC_CONCURRENCY = '5'
        const s = getSettings()
        expect(s.jobEnabled).to.equal(true)
        expect(s.concurrency).to.equal(5)
        expect(s.samplePercent).to.equal(10)
    })

    it('accepts a valid partial update', () => {
        expect(validateSettings({ schedule: '0 */2 * * *', samplePercent: 5, model: 'gemini-2.5-pro' })).to.deep.equal({
            schedule: '0 */2 * * *',
            samplePercent: 5,
            model: 'gemini-2.5-pro',
        })
    })

    it('rejects an invalid cron expression', () => {
        const e = badRequest({ schedule: 'every hour' })
        expect(e.status).to.equal(400)
        expect(e.message).to.match(/cron/)
    })

    it('rejects out-of-range values', () => {
        expect(badRequest({ samplePercent: 0 }).status).to.equal(400)
        expect(badRequest({ concurrency: 50 }).status).to.equal(400)
        expect(badRequest({ temperature: 3 }).status).to.equal(400)
        expect(badRequest({ model: 'gpt-4o' }).status).to.equal(400)
    })

    it('rejects read-only, unknown or empty updates', () => {
        expect(badRequest({ promptFile: 'other.txt' }).message).to.match(/not allowed/)
        expect(badRequest({ region: 'us-central1' }).message).to.match(/not allowed/)
        expect(badRequest({}).status).to.equal(400)
    })
})
