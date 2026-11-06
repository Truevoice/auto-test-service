const { expect } = require('chai')
const { validateFile } = require('../services/qc/qc_files')
const { missingFromEnv } = require('../services/qc/qc_settings')

const rejected = (id, content) => {
    try {
        validateFile(id, content)
    } catch (e) {
        return e
    }
    return null
}

describe('qc files', () => {
    it('accepts a non-empty prompt and a JSON object schema', () => {
        expect(validateFile('promptFile', '# Judge\nScore the call.')).to.be.a('string')
        expect(validateFile('schemaFile', '{"type":"object"}')).to.be.a('string')
    })

    it('rejects empty content and unknown files', () => {
        expect(rejected('promptFile', '   ').status).to.equal(400)
        expect(rejected('promptFile', undefined).status).to.equal(400)
        expect(rejected('otherFile', 'x').status).to.equal(400)
    })

    it('rejects a schema that is not a JSON object', () => {
        expect(rejected('schemaFile', '{"type": "object",}').message).to.match(/not valid JSON/)
        expect(rejected('schemaFile', '[1, 2]').message).to.match(/JSON object/)
    })
})

describe('qc settings seeding', () => {
    it('fills only the settings that the DB does not have yet, from env', () => {
        const saved = { ...process.env }
        process.env.QC_CONCURRENCY = '4'
        const seed = missingFromEnv({ schedule: '0 8 * * *', samplePercent: 20 })
        process.env = saved
        expect(seed).to.not.have.any.keys('schedule', 'samplePercent')
        expect(seed.concurrency).to.equal(4)
        expect(seed).to.include.keys('jobEnabled', 'lookbackHours', 'model', 'temperature')
    })
})
