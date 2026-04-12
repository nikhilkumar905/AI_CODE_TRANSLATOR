const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const isDemoMode =
  !OPENAI_API_KEY ||
  OPENAI_API_KEY === 'your_openai_api_key_here' ||
  OPENAI_API_KEY === 'YOUR_ACTUAL_API_KEY_HERE';

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

// Demo conversion function (works without API key)
function demoConvert(code, sourceLanguage, targetLanguage) {
  const target = targetLanguage.toLowerCase();
  const source = sourceLanguage === 'auto' ? 'unknown' : sourceLanguage.toLowerCase();
  
  // Simple demo conversions
  const conversions = {
    'javascript_python': `# Converted from JavaScript to Python (DEMO MODE)
# Original code:
# ${code.replace(/\n/g, '\n# ')}

# TODO: Replace with actual conversion
print("Demo conversion - Please add a valid OpenAI API key")`,

    'python_javascript': `// Converted from Python to JavaScript (DEMO MODE)
// Original code:
// ${code.replace(/\n/g, '\n// ')}

// TODO: Replace with actual conversion
console.log("Demo conversion - Please add a valid OpenAI API key");`,

    'java_python': `# Converted from Java to Python (DEMO MODE)
# Original code:
# ${code.replace(/\n/g, '\n# ')}

# TODO: Replace with actual conversion
print("Demo conversion - Please add a valid OpenAI API key")`,

    'python_java': `// Converted from Python to Java (DEMO MODE)
// Original code:
// ${code.replace(/\n/g, '\n// ')}

// TODO: Replace with actual conversion
public class Demo {
    public static void main(String[] args) {
        System.out.println("Demo conversion - Please add a valid OpenAI API key");
    }
}`,

    'cpp_python': `# Converted from C++ to Python (DEMO MODE)
# Original code:
# ${code.replace(/\n/g, '\n# ')}

# TODO: Replace with actual conversion
print("Demo conversion - Please add a valid OpenAI API key")`,

    'python_cpp': `// Converted from Python to C++ (DEMO MODE)
// Original code:
// ${code.replace(/\n/g, '\n// ')}

#include <iostream>
int main() {
    std::cout << "Demo conversion - Please add a valid OpenAI API key" << std::endl;
    return 0;
}`,

    'c_python': `# Converted from C to Python (DEMO MODE)
# Original code:
# ${code.replace(/\n/g, '\n# ')}

# TODO: Replace with actual conversion
print("Demo conversion - Please add a valid OpenAI API key")`,

    'python_c': `// Converted from Python to C (DEMO MODE)
// Original code:
// ${code.replace(/\n/g, '\n// ')}

#include <stdio.h>
int main() {
    printf("Demo conversion - Please add a valid Gemini API key\\n");
    return 0;
}`,

    'default': `// DEMO MODE - Conversion from ${source} to ${target}
// Please add a valid OpenAI API key to enable real conversion

/*
Original code:
${code}
*/

// Demo output
console.log("Demo mode - Add valid API key for real conversion");`
  };

  const key = `${source}_${target}`;
  return conversions[key] || conversions['default'];
}

function buildPrompt(code, sourceLanguage, targetLanguage) {
  const source = sourceLanguage === 'auto' 
    ? 'the detected source language' 
    : normalizeLanguage(sourceLanguage);
  const target = normalizeLanguage(targetLanguage);

  return `Task: Convert the following code from ${source} to ${target}.

Rules:
- Keep the logic exactly the same
- Do not add extra features
- Use best practices of the target language
- Ensure the code is correct and runnable
- Maintain proper indentation and formatting
- Do not include explanations unless asked
- Do not wrap the output in markdown code blocks

Input Code:
${code}

Output:
Provide only the converted code.`;
}

async function convertCode(code, sourceLanguage, targetLanguage) {
  if (isDemoMode) {
    console.log('Running in DEMO mode - Add valid OpenAI API key for real conversion');
    return {
      success: true,
      convertedCode: demoConvert(code, sourceLanguage, targetLanguage),
      detectedLanguage: sourceLanguage === 'auto' ? 'auto-detected (demo)' : null,
      demoMode: true
    };
  }

  try {
    const prompt = buildPrompt(code, sourceLanguage, targetLanguage);

    if (typeof fetch !== 'function') {
      throw new Error('Global fetch is not available in this Node.js runtime.');
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'You are an expert code translator. Return only converted code with no markdown fences.'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const apiError = data?.error?.message || `OpenAI API request failed with status ${response.status}`;
      throw new Error(apiError);
    }

    let convertedCode = data?.choices?.[0]?.message?.content || '';

    if (!convertedCode || typeof convertedCode !== 'string') {
      throw new Error('OpenAI API returned empty conversion output.');
    }
    
    // Clean up the response - remove markdown code blocks if present
    convertedCode = convertedCode.replace(/```[\w]*\n?/g, '').trim();
    
    return {
      success: true,
      convertedCode,
      detectedLanguage: sourceLanguage === 'auto' ? 'auto-detected' : null
    };
  } catch (error) {
    console.error('OpenAI API Error:', error);
    return {
      success: true,
      convertedCode: demoConvert(code, sourceLanguage, targetLanguage),
      detectedLanguage: sourceLanguage === 'auto' ? 'auto-detected (demo)' : null,
      demoMode: true,
      error: error.message
    };
  }
}

module.exports = {
  convertCode,
  normalizeLanguage
};
