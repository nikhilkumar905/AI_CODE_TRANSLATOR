const LANGUAGES = [
  { value: 'auto', label: 'Auto Detect' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'java', label: 'Java' },
  { value: 'python', label: 'Python' },
  { value: 'javascript', label: 'JavaScript' }
];

const TARGET_LANGUAGES = LANGUAGES.filter(lang => lang.value !== 'auto');

function LanguageSelector({ 
  value, 
  onChange, 
  label = 'Language',
  allowAuto = false 
}) {
  const options = allowAuto ? LANGUAGES : TARGET_LANGUAGES;

  return (
    <div className="language-selector">
      <label className="selector-label">{label}</label>
      <select 
        value={value} 
        onChange={(e) => onChange(e.target.value)}
        className="selector-dropdown"
      >
        {options.map((lang) => (
          <option key={lang.value} value={lang.value}>
            {lang.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default LanguageSelector;
