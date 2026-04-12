// Specialized converter for Python to C++ and vice versa
// Uses pattern matching for common conversion scenarios

const PYTHON_TO_CPP_PATTERNS = [
  // Print statements
  { pattern: /print\(([^)]+)\)/g, replacement: 'cout << $1 << endl;' },
  { pattern: /print\(f["'](.+?)["']\)/g, replacement: 'cout << "$1" << endl;' },
  
  // Variable declarations
  { pattern: /(\w+)\s*=\s*(.+?)(?=[;\n]|$)/g, replacement: 'auto $1 = $2;' },
  
  // Function definitions
  { pattern: /def\s+(\w+)\s*\(([^)]*)\):/g, replacement: '$1($2) {' },
  
  // Loops
  { pattern: /for\s+(\w+)\s+in\s+range\((\w+)\):/g, replacement: 'for (int $1 = 0; $1 < $2; $1++) {' },
  { pattern: /for\s+(\w+)\s+in\s+range\((\w+),\s*(\w+)\):/g, replacement: 'for (int $1 = $2; $1 < $3; $1++) {' },
  
  // Lists/Arrays
  { pattern: /\[(.*?)\]/g, replacement: '{$1}' },
  
  // Comments
  { pattern: /#(.*)/g, replacement: '//$1' }
];

const CPP_TO_PYTHON_PATTERNS = [
  // Cout to print
  { pattern: /cout\s*<<\s*([^;]+);\s*endl;/g, replacement: 'print($1)' },
  { pattern: /cout\s*<<\s*([^;]+);/g, replacement: 'print($1)' },
  
  // Variable declarations
  { pattern: /(int|float|double|char|string)\s+(\w+)\s*=\s*(.+?);/g, replacement: '$2 = $3' },
  { pattern: /auto\s+(\w+)\s*=\s*(.+?);/g, replacement: '$1 = $2' },
  
  // Function definitions
  { pattern: /(\w+)\s*\(([^)]*)\)\s*\{/g, replacement: 'def $1($2):' },
  
  // Loops
  { pattern: /for\s*\(\s*int\s+(\w+)\s*=\s*0;\s*\1\s*<\s*(\w+);\s*\1\+\+\s*\)\s*\{/g, replacement: 'for $1 in range($2):' },
  { pattern: /for\s*\(\s*int\s+(\w+)\s*=\s*(\w+);\s*\1\s*<\s*(\w+);\s*\1\+\+\s*\)\s*\{/g, replacement: 'for $1 in range($2, $3):' },
  
  // Arrays
  { pattern: /\{([^}]*)\}/g, replacement: '[$1]' },
  
  // Comments
  { pattern: /\/\/(.*)/g, replacement: '#$1' }
];

function convertPythonToCpp(code) {
  let result = code;
  
  // Apply patterns
  for (const { pattern, replacement } of PYTHON_TO_CPP_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  
  // Add C++ headers and main function if needed
  if (!result.includes('#include')) {
    result = `#include <iostream>
#include <vector>
using namespace std;

int main() {
${result.split('\n').map(line => `    ${line}`).join('\n')}
    return 0;
}`
  }
  
  return result;
}

function convertCppToPython(code) {
  let result = code;
  
  // Remove C++ boilerplate
  result = result
    .replace(/#include\s*<[^>]+>/g, '')
    .replace(/using\s+namespace\s+\w+;/g, '')
    .replace(/int\s+main\s*\(\s*\)\s*\{/g, '')
    .replace(/\s*return\s+0;\s*\}/g, '')
    .replace(/^\s*\}\s*$/gm, '');
  
  // Apply patterns
  for (const { pattern, replacement } of CPP_TO_PYTHON_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  
  // Clean up indentation
  result = result
    .split('\n')
    .filter(line => line.trim())
    .map(line => line.replace(/^\s{4}/, ''))
    .join('\n');
  
  return result.trim();
}

function convertCodeSpecialized(code, sourceLanguage, targetLanguage) {
  const source = sourceLanguage.toLowerCase();
  const target = targetLanguage.toLowerCase();
  
  if (source === 'python' && target === 'cpp') {
    return {
      success: true,
      convertedCode: convertPythonToCpp(code),
      provider: 'Custom Python-C++ Converter'
    };
  }
  
  if (source === 'cpp' && target === 'python') {
    return {
      success: true,
      convertedCode: convertCppToPython(code),
      provider: 'Custom C++-Python Converter'
    };
  }
  
  // For other language pairs, return error to force use of main LLM
  return {
    success: false,
    error: 'Use main LLM service for this language pair'
  };
}

module.exports = { convertCodeSpecialized };
