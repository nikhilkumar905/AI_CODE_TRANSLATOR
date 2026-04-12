import { useState, useCallback } from 'react';
import CodeEditor from './components/CodeEditor';
import LanguageSelector from './components/LanguageSelector';
import useCodeConversion from './hooks/useCodeConversion';
import './App.css';

const DEFAULT_CODE = `function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

console.log(fibonacci(10));`;

function App() {
  const [inputCode, setInputCode] = useState(DEFAULT_CODE);
  const [outputCode, setOutputCode] = useState('');
  const [conversionInfo, setConversionInfo] = useState(null);
  const [sourceLanguage, setSourceLanguage] = useState('javascript');
  const [targetLanguage, setTargetLanguage] = useState('python');
  const [copied, setCopied] = useState(false);

  const { convertCode, isLoading, error, clearError } = useCodeConversion();

  const handleConvert = async () => {
    if (!inputCode.trim()) return;
    
    clearError();
    const result = await convertCode(inputCode, sourceLanguage, targetLanguage);
    
    if (result.success) {
      setOutputCode(result.convertedCode);
      setConversionInfo({
        provider: result.provider,
        conversionTime: result.conversionTime,
        detectedLanguage: result.detectedLanguage
      });
    }
  };

  const handleCopy = useCallback(async () => {
    if (!outputCode) return;
    
    try {
      await navigator.clipboard.writeText(outputCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [outputCode]);

  const handleSwapLanguages = () => {
    if (sourceLanguage !== 'auto') {
      const temp = sourceLanguage;
      setSourceLanguage(targetLanguage);
      setTargetLanguage(temp);
    }
  };

  const handleClear = () => {
    setInputCode('');
    setOutputCode('');
    setConversionInfo(null);
    clearError();
  };

  return (
    <div className="app">
      <div className="storm-bg" aria-hidden="true">
        <span className="bolt"></span>
        <span className="bolt-2"></span>
      </div>

      <header className="app-header">
        <h1 className="app-title">AI Code Translator</h1>
        <p className="app-subtitle">
          Convert code between C, C++, Java, Python, and JavaScript
        </p>
      </header>

      <main className="app-main">
        <div className="controls-container">
          <div className="language-controls">
            <LanguageSelector
              label="From"
              value={sourceLanguage}
              onChange={setSourceLanguage}
              allowAuto={true}
            />
            
            <button 
              className="swap-button"
              onClick={handleSwapLanguages}
              disabled={sourceLanguage === 'auto'}
              title={sourceLanguage === 'auto' ? 'Cannot swap when using auto-detect' : 'Swap languages'}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M7 16V4M7 4L3 8M7 4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/>
              </svg>
            </button>

            <LanguageSelector
              label="To"
              value={targetLanguage}
              onChange={setTargetLanguage}
              allowAuto={false}
            />
          </div>

          <div className="action-buttons">
            <button 
              className="btn btn-secondary"
              onClick={handleClear}
            >
              Clear
            </button>
            <button 
              className="btn btn-primary"
              onClick={handleConvert}
              disabled={isLoading || !inputCode.trim()}
            >
              {isLoading ? (
                <>
                  <span className="spinner"></span>
                  Converting...
                </>
              ) : (
                'Convert'
              )}
            </button>
          </div>
        </div>

        {error && (
          <div className="error-message">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {error}
          </div>
        )}

        {conversionInfo && (
          <div className="info-bar">
            <div className="info-item">
              <span className="info-label">Provider:</span>
              <span className="info-value">{conversionInfo.provider}</span>
            </div>
            {conversionInfo.conversionTime && (
              <div className="info-item">
                <span className="info-label">Time:</span>
                <span className="info-value">{conversionInfo.conversionTime}</span>
              </div>
            )}
            {conversionInfo.detectedLanguage && (
              <div className="info-item">
                <span className="info-label">Detected:</span>
                <span className="info-value">{conversionInfo.detectedLanguage}</span>
              </div>
            )}
          </div>
        )}

        <div className="editors-container">
          <div className="editor-wrapper">
            <CodeEditor
              value={inputCode}
              onChange={setInputCode}
              language={sourceLanguage === 'auto' ? 'javascript' : sourceLanguage}
              title="Input Code"
              height="560px"
            />
          </div>

          <div className="editor-wrapper">
            <div className="output-header">
              <CodeEditor
                value={outputCode}
                onChange={() => {}}
                language={targetLanguage}
                readOnly={true}
                title="Converted Code"
                height="560px"
              />
              {outputCode && (
                <button 
                  className={`copy-button ${copied ? 'copied' : ''}`}
                  onClick={handleCopy}
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                      Copy
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </main>

      <footer className="app-footer">
        <p>Powered by Ollama</p>
      </footer>
    </div>
  );
}

export default App;
