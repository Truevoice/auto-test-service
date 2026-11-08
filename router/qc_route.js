const express = require('express')
const router = express.Router()
const QcController = require('../controllers/qc_controller')
const qcController = new QcController()

router.post('/qc/run', qcController.run)
router.get('/qc/runs', qcController.runs)
router.get('/qc/runs/latest', qcController.latestRun)
router.get('/qc/runs/:id', qcController.runDetail)
router.post('/qc/sessions', qcController.list)
router.get('/qc/sessions/:bot_session_id', qcController.detail)
router.get('/qc/results/:bot_session_id', qcController.result)
router.get('/qc/config', qcController.config)
router.put('/qc/config', qcController.updateConfig)
router.get('/qc/models', qcController.models)
router.get('/qc/config/files/:id', qcController.configFile)
router.put('/qc/config/files/:id', qcController.updateConfigFile)

module.exports = router
