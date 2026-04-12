import Editor from '@monaco-editor/react';

const LANGUAGE_MAP = {
  'c': 'c',
  'cpp': 'cpp',
  'java': 'java',
  'python': 'python',
  'javascript': 'javascript'
};

function CodeEditor({ 
  value, 
  onChange, 
  language = 'javascript', 
  readOnly = false,
  height = '400px',
  title = 'Code Editor'
}) {
  const editorLanguage = LANGUAGE_MAP[language.toLowerCase()] || language.toLowerCase();

  const handleEditorChange = (newValue) => {
    if (onChange) {
      onChange(newValue || '');
    }
  };

  return (
    <div className="editor-container">
      <div className="editor-header">
        <span className="editor-title">{title}</span>
        {readOnly && <span className="read-only-badge">Read Only</span>}
      </div>
      <Editor
        height={height}
        language={editorLanguage}
        value={value}
        onChange={handleEditorChange}
        theme="vs-dark"
        options={{
          readOnly: readOnly,
          minimap: { enabled: false },
          fontSize: 14,
          lineNumbers: 'on',
          roundedSelection: false,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 4,
          wordWrap: 'on',
          folding: true,
          renderLineHighlight: 'all',
          selectOnLineNumbers: true,
          matchBrackets: 'always',
        }}
      />
    </div>
  );
}

export default CodeEditor;
