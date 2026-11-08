const { expect } = require('chai')
const { runPool } = require('../services/qc/qc_job')

describe('qc run pool', () => {
    it('gives each worker a slot number 1..concurrency and never runs more than that at once', async () => {
        const seen = []
        let active = 0
        let peak = 0
        await runPool(
            [1, 2, 3, 4, 5, 6, 7],
            async (item, slot) => {
                active++
                peak = Math.max(peak, active)
                seen.push({ item, slot })
                await new Promise((r) => setTimeout(r, 5 + (item % 3)))
                active--
            },
            3,
        )
        expect(seen.map((s) => s.item).sort()).to.deep.equal([1, 2, 3, 4, 5, 6, 7])
        expect(new Set(seen.map((s) => s.slot))).to.deep.equal(new Set([1, 2, 3]))
        expect(peak).to.equal(3)
    })

    it('uses at least one slot when concurrency is 0', async () => {
        const slots = []
        await runPool(['a', 'b'], async (_, slot) => slots.push(slot), 0)
        expect(slots).to.deep.equal([1, 1])
    })
})
