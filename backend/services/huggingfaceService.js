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

  return `Convert ${source} code to ${target}. Only output code, no explanation.

${source} code:
${code}

${target} code:`;
}

// Simple code template translations
function templateConvert(code, sourceLanguage, targetLanguage) {
  let result = '';
  
  if (sourceLanguage === 'javascript' && targetLanguage === 'python') {
    let lines = code.split('\n');
    result = lines.map(line => {
      line = line.replace(/function\s+(\w+)\s*\(([^)]*)\)\s*\{/, 'def $1($2):');
      line = line.replace(/const\s+/g, '');
      line = line.replace(/let\s+/g, '');
      line = line.replace(/var\s+/g, '');
      line = line.replace(/;\s*$/g, '');
      line = line.replace(/console\.log\((.*)\)/, 'print($1)');
      line = line.replace(/return\s+(.+)/, 'return $1');
      line = line.replace(/\}\s*$/g, '');
      return line;
    }).join('\n');
  } 
  else if (sourceLanguage === 'python' && targetLanguage === 'javascript') {
    let lines = code.split('\n');
    result = lines.map(line => {
      line = line.replace(/def\s+(\w+)\s*\(([^)]*)\)\s*:/, 'function $1($2) {');
      line = line.replace(/print\((.*)\)/, 'console.log($1);');
      line = line.replace(/:\s*$/g, ' {');
      line = line.replace(/\s+pass\s*$/g, '');
      return line;
    }).join('\n');
  }
  else {
    result = '// Conversion not implemented for this language pair';
  }
  
  return result;
}

async function convertCode(code, sourceLanguage, targetLanguage) {
  const prompt = buildPrompt(code, sourceLanguage, targetLanguage);
  
  try {
    // Try Hugging Face Inference API with a small fast model
    const response = await fetch('https://api-inference.huggingface.co/models/microsoft/phi-2', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.HUGGINGFACE_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          max_new_tokens: 300,
          temperature: 0.3,
          return_full_text: false
        }
      })
    });

    if (response.status === 503) {
      // Model loading, return template-based conversion
      console.log('Model loading, using template conversion');
      const converted = templateConvert(code, sourceLanguage, targetLanguage);
      return {
        success: true,
        convertedCode: converted,
        provider: 'Template Converter (Model loading)'
      };
    }

    if (response.status === 403) {
      // Access denied, use template
      console.log('Access denied, using template conversion');
      const converted = templateConvert(code, sourceLanguage, targetLanguage);
      return {
        success: true,
        convertedCode: converted,
        provider: 'Template Converter (Access denied)'
      };
    }

    if (!response.ok) {
      // Use template conversion
      const converted = templateConvert(code, sourceLanguage, targetLanguage);
      return {
        success: true,
        convertedCode: converted,
        provider: 'Template Converter (API error: ' + response.status + ')'
      };
    }

    const data = await response.json();
    
    let convertedCode = '';
    if (Array.isArray(data) && data[0] && data[0].generated_text) {
      convertedCode = data[0].generated_text;
    } else if (data.generated_text) {
      convertedCode = data.generated_text;
    } else {
      // Use template if response invalid
      convertedCode = templateConvert(code, sourceLanguage, targetLanguage);
    }
    
    convertedCode = convertedCode.replace(/```[\w]*\n?/g, '').trim();
    
    return {
      success: true,
      convertedCode,
      detectedLanguage: sourceLanguage === 'auto' ? 'auto-detected' : null,
      provider: 'Hugging Face'
    };
  } catch (error) {
    console.log('Using template conversion:', error.message);
    // Fallback to template-based conversion
    const convertedCode = templateConvert(code, sourceLanguage, targetLanguage);
    return {
      success: true,
      convertedCode,
      provider: 'Template Converter (Error fallback)'
    };
  }
}

module.exports = {
  convertCode,
  normalizeLanguage
};
