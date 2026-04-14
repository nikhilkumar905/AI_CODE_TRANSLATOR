import { useState, useCallback } from 'react';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const API_URL = API_BASE_URL ? `${API_BASE_URL}/api/convert` : '/api/convert';

function useCodeConversion() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const convertCode = useCallback(async (code, sourceLanguage, targetLanguage) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code,
          sourceLanguage,
          targetLanguage
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to convert code');
      }

      return {
        success: true,
        convertedCode: data.convertedCode,
        detectedLanguage: data.detectedLanguage,
        provider: data.provider,
        conversionTime: data.conversionTime
      };
    } catch (err) {
      const isPyCppPair =
        (sourceLanguage === 'python' && targetLanguage === 'cpp') ||
        (sourceLanguage === 'cpp' && targetLanguage === 'python');

      const rawMessage = err?.message || 'Failed to convert code';
      const normalizedMessage = String(rawMessage).toLowerCase();

      const isFetchFailure =
        normalizedMessage.includes('failed to fetch') ||
        normalizedMessage.includes('fetch failed');

      const displayMessage = (!isPyCppPair && isFetchFailure)
        ? 'Ollama is not available on this server. Download and run Ollama first, then try again.'
        : rawMessage;

      setError(displayMessage);
      return {
        success: false,
        error: displayMessage
      };
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    convertCode,
    isLoading,
    error,
    clearError: () => setError(null)
  };
}

export default useCodeConversion;
