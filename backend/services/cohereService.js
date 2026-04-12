const LANGUAGE_MAP = {
  'c': 'C',
  'cpp': 'C++',
  'cplusplus': 'C++',
  'java': 'Java',
  'python': 'Python',
  'py': 'Python',
  'javascript': 'JavaScript',
  'js': 'JavaScript'
};

function normalizeLanguage(lang) {
  const normalized = lang.toLowerCase().trim();
  return LANGUAGE_MAP[normalized] || lang;
}

function buildPrompt(code, sourceLanguage, targetLanguage) {
  const source = sourceLanguage === 'auto' 
    ? 'the detected source language' 
    : normalizeLanguage(sourceLanguage);
  const target = normalizeLanguage(targetLanguage);

  return `You are an expert software engineer. Convert the following ${source} code to ${target}.
Keep the logic exactly the same. Use best practices for ${target}.
Return only the converted code, no explanations.

${source} code:
${code}

${target} code:`;
}

async function convertCode(code, sourceLanguage, targetLanguage) {
  const prompt = buildPrompt(code, sourceLanguage, targetLanguage);
  
  try {
    const response = await fetch('https://api.cohere.ai/v1/chat', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.COHERE_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'command-r',
        message: prompt,
        max_tokens: 800,
        temperature: 0.3,
        k: 0,
        p: 0.75,
        frequency_penalty: 0.3,
        presence_penalty: 0
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Cohere API error: ${response.status} - ${errorData.message || 'Unknown error'}`);
    }

    const data = await response.json();
    
    if (!data.text) {
      throw new Error('Invalid response from Cohere API');
    }
    
    let convertedCode = data.text || '';
    
    convertedCode = convertedCode
      .replace(/```[\w]*\n?/g, '')
      .replace(/^\s*\n/, '')
      .replace(/\n\s*$/, '')
      .trim();
    
    if (!convertedCode || convertedCode.length < 10) {
      throw new Error('Generated code is too short or empty');
    }
    
    return {
      success: true,
      convertedCode,
      detectedLanguage: sourceLanguage === 'auto' ? 'auto-detected' : null,
      provider: 'Cohere AI'
    };
  } catch (error) {
    console.error('Cohere API Error:', error);
    return {
      success: false,
      error: error.message || 'Failed to convert code using Cohere API'
    };
  }
}

module.exports = {
  convertCode,
  normalizeLanguage
};
