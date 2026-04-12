const express = require('express');
const router = express.Router();
const { convertCode } = require('../services/ollamaService');
const CONVERT_TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS || 45000);

router.post('/', async (req, res) => {
  try {
    const { code, sourceLanguage, targetLanguage } = req.body;

    // Validation
    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Code is required and must be a non-empty string'
      });
    }

    if (!targetLanguage || typeof targetLanguage !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Target language is required'
      });
    }

    if (!sourceLanguage) {
      return res.status(400).json({
        success: false,
        error: 'Source language is required'
      });
    }

    const supportedLanguages = ['c', 'cpp', 'java', 'python', 'javascript', 'auto'];
    const normalizedSource = sourceLanguage.toLowerCase();
    const normalizedTarget = targetLanguage.toLowerCase();

    if (!supportedLanguages.includes(normalizedSource)) {
      return res.status(400).json({
        success: false,
        error: `Unsupported source language. Supported: ${supportedLanguages.join(', ')}`
      });
    }

    if (!supportedLanguages.filter(l => l !== 'auto').includes(normalizedTarget)) {
      return res.status(400).json({
        success: false,
        error: `Unsupported target language. Supported: ${supportedLanguages.filter(l => l !== 'auto').join(', ')}`
      });
    }

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Conversion timed out')), CONVERT_TIMEOUT_MS);
    });
    let result;
    try {
      result = await Promise.race([
        convertCode(code, normalizedSource, normalizedTarget),
        timeoutPromise
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!result.success) {
      return res.status(500).json({ ...result, requestId: req.requestId });
    }

    res.json({
      success: true,
      convertedCode: result.convertedCode,
      detectedLanguage: result.detectedLanguage,
      provider: result.provider || 'Ollama',
      requestId: req.requestId
    });
  } catch (error) {
    console.error('Convert route error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      requestId: req.requestId
    });
  }
});

module.exports = router;
