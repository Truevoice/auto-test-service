const { expect } = require('chai')
const { copyBatches, cursorFilter, batchCount } = require('../services/pipeline/pipeline_job')
const { validateSettings, scheduleOf } = require('../services/pipeline/pipeline_settings')
const { failedReason, toRunView } = require('../services/pipeline/pipeline_run_service')

// ตัวตรวจ filter แบบย่อ พอสำหรับ filter ที่ pipeline สร้าง ($and/$or/$gte/$lt/$gt/เท่ากับ)
const cmp = (a, b) => (a instanceof Date ? a.getTime() : a) - (b instanceof Date ? b.getTime() : b)
const matches = (doc, filter) =>
    Object.entries(filter).every(([key, cond]) => {
        if (key === '$and') return cond.every((f) => matches(doc, f))
        if (key === '$or') return cond.some((f) => matches(doc, f))
        const v = doc[key]
        if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
            return Object.entries(cond).every(([op, x]) => {
                if (op === '$gte') return cmp(v, x) >= 0
                if (op === '$gt') return cmp(v, x) > 0
                if (op === '$lt') return cmp(v, x) < 0
                throw new Error(`unsupported ${op}`)
            })
        }
        return cmp(v, cond) === 0
    })

const fakeSource = (docs, { failReadsAt = [] } = {}) => {
    let reads = 0
    return {
        reads: () => reads,
        find: (filter) => {
            let sort = null
            let limit = Infinity
            const cursor = {
                sort: (s) => ((sort = s), cursor),
                limit: (n) => ((limit = n), cursor),
                toArray: async () => {
                    reads++
                    if (failReadsAt.includes(reads)) throw new Error('network blip')
                    const out = docs.filter((d) => matches(d, filter))
                    if (sort) out.sort((a, b) => cmp(a.created_at, b.created_at) || cmp(a._id, b._id))
                    return out.slice(0, limit).map((d) => ({ ...d }))
                },
            }
            return cursor
        },
    }
}

const fakeTarget = () => {
    const store = new Map()
    return {
        store,
        bulkWrite: async (ops) => {
            for (const { replaceOne } of ops) store.set(replaceOne.filter._id, replaceOne.replacement)
        },
    }
}

const base = new Date('2026-11-01T00:00:00Z').getTime()
// 23 sessions หลายตัวเวลาเดียวกัน (ทดสอบ cursor ที่ created_at ซ้ำ)
const makeDocs = (n) =>
    Array.from({ length: n }, (_, i) => ({ _id: i + 1, created_at: new Date(base + Math.floor(i / 3) * 1000), v: i }))
const range = { from: new Date(base), to: new Date(base + 3600_000) }

describe('data-pipeline', () => {
    it('counts batches as ceil(total / limit)', () => {
        expect(batchCount(230, 50)).to.equal(5)
        expect(batchCount(200, 50)).to.equal(4)
        expect(batchCount(0, 50)).to.equal(0)
    })

    it('builds a keyset filter after the cursor (later time, or same time and larger _id)', () => {
        const at = new Date(base)
        const f = cursorFilter(range, { created_at: at, _id: 7 })
        expect(matches({ created_at: at, _id: 7 }, f)).to.equal(false)
        expect(matches({ created_at: at, _id: 8 }, f)).to.equal(true)
        expect(matches({ created_at: new Date(base + 1), _id: 1 }, f)).to.equal(true)
        expect(matches({ created_at: new Date(base - 1), _id: 99 }, f)).to.equal(false)
        expect(cursorFilter(range, null)).to.deep.equal({ created_at: { $gte: range.from, $lt: range.to } })
    })

    it('copies every session in batches, moving the cursor after each write', async () => {
        const docs = makeDocs(23)
        const target = fakeTarget()
        const batches = []
        const result = await copyBatches({
            source: fakeSource(docs),
            target,
            range,
            limit: 5,
            onBatch: async (b) => batches.push(b),
        })
        expect(result).to.equal('DONE')
        expect(batches.map((b) => b.count)).to.deep.equal([5, 5, 5, 5, 3])
        expect(target.store.size).to.equal(23)
        expect(batches.at(-1).cursor._id).to.equal(23)
    })

    it('resumes from a saved cursor without gaps or duplicates', async () => {
        const docs = makeDocs(23)
        const target = fakeTarget()
        let saved = null
        let n = 0
        // ระบบปิดหลังชุดที่ 2
        const first = await copyBatches({
            source: fakeSource(docs),
            target,
            range,
            limit: 5,
            onBatch: async (b) => {
                saved = b.cursor
                n += b.count
            },
            shouldStop: () => n >= 10,
        })
        expect(first).to.equal('STOPPED')
        expect(target.store.size).to.equal(10)
        const second = await copyBatches({
            source: fakeSource(docs),
            target,
            range,
            limit: 5,
            cursor: saved,
            onBatch: async (b) => (n += b.count),
        })
        expect(second).to.equal('DONE')
        expect(n).to.equal(23)
        expect([...target.store.keys()].sort((a, b) => a - b)).to.deep.equal(docs.map((d) => d._id))
    })

    it('retries a failed read and overwrites sessions that already exist', async () => {
        const docs = makeDocs(6)
        const target = fakeTarget()
        target.store.set(1, { _id: 1, v: 'old' })
        const source = fakeSource(docs, { failReadsAt: [1] })
        await copyBatches({ source, target, range, limit: 10, onBatch: async () => {} })
        expect(source.reads()).to.equal(2)
        expect(target.store.get(1).v).to.equal(0)
        expect(target.store.size).to.equal(6)
    }).timeout(5000)

    it('only accepts intervals that divide a day and limits within range', () => {
        expect(validateSettings({ intervalHours: 6, batchLimit: 50 })).to.deep.equal({ intervalHours: 6, batchLimit: 50 })
        expect(() => validateSettings({ intervalHours: 5 })).to.throw(/intervalHours/)
        expect(() => validateSettings({ batchLimit: 0 })).to.throw()
        expect(() => validateSettings({ batchLimit: 5000 })).to.throw()
        expect(() => validateSettings({ sourceUri: 'mongodb://x' })).to.throw()
        expect(scheduleOf(1)).to.equal('0 */1 * * *')
        expect(scheduleOf(24)).to.equal('0 0 * * *')
    })

    it('never sends the raw error or the source cursor to the UI', () => {
        const view = toRunView({
            _id: 'r',
            status: 'FAILED',
            error: 'connect ECONNREFUSED 10.0.0.5:27017',
            cursor: { _id: 'x' },
            lock: 'active',
            owner: 'host-a:1234:abcdef',
            heartbeat_at: new Date(),
        })
        for (const key of ['error', 'cursor', 'lock', 'owner', 'heartbeat_at']) expect(view).to.not.have.property(key)
        expect(view.failed_reason).to.equal('ERROR')
        expect(failedReason('FAILED', 'NOT_CONFIGURED')).to.equal('NOT_CONFIGURED')
    })
})

describe('ssh tunnel local port check', () => {
    const net = require('net')
    const { portInUse, openTunnel } = require('../db/connection_config')

    it('sees a port that another program already listens on, and refuses to open the tunnel there', async () => {
        const server = net.createServer().listen(0, '127.0.0.1')
        await new Promise((r) => server.once('listening', r))
        const { port } = server.address()
        try {
            expect(await portInUse(port)).to.equal(true)
            let err
            try {
                await openTunnel({ localPort: port, host: 'unused', port: 22 }, 'Test tunnel')
            } catch (e) {
                err = e
            }
            expect(err?.code).to.equal('PORT_IN_USE')
        } finally {
            server.close()
        }
        expect(await portInUse(port)).to.equal(false)
    })
})
