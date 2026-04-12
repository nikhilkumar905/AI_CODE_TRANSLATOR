#!/usr/bin/env python3
"""
Python ↔ C++ Converter Script
Called by Node.js service
"""

import sys
import json
import re

class RuleBasedConverter:
    def __init__(self):
        self.python_to_cpp = [
            (r"print\('(.*?)'\)", r'cout << "\1" << endl;'),
            (r'print\("(.*?)"\)', r'cout << "\1" << endl;'),
            (r"print\(([^)]+)\)", r"cout << \1 << endl;"),
            (r"^(\w+)\s*=\s*(\d+)$", r"int \1 = \2;"),
            (r"^(\w+)\s*=\s*'(.*)'$", r'string \1 = "\2";'),
            (r'^(\w+)\s*=\s*"(.*)"$', r'string \1 = "\2";'),
            (r"^(\w+)\s*=\s*([0-9.]+)$", r"double \1 = \2;"),
            (r"^(\w+)\s*=\s*(True|False)$", r"bool \1 = \2;"),
            (r"^for\s+(\w+)\s+in\s+range\((\d+)\):$", r"for (int \1 = 0; \1 < \2; \1++) {"),
            (r"^for\s+(\w+)\s+in\s+range\((\d+),\s*(\d+)\):$", r"for (int \1 = \2; \1 < \3; \1++) {"),
            (r"^while\s+(.+):$", r"while (\1) {"),
            (r"^if\s+(.+):$", r"if (\1) {"),
            (r"^elif\s+(.+):$", r"} else if (\1) {"),
            (r"^else:$", r"} else {"),
        ]
        
        self.cpp_to_python = [
            (r'cout << "(.*?)" << endl;', r"print('\1')"),
            (r"cout << (.*?) << endl;", r"print(\1)"),
            (r"int (\w+) = (\d+);", r"\1 = \2"),
            (r'string (\w+) = "(.*?)";', r"\1 = '\2'"),
            (r"double (\w+) = ([0-9.]+);", r"\1 = \2"),
            (r"bool (\w+) = (.*?);", r"\1 = \2"),
            (r"for \(int (\w+) = 0; \1 < (\d+); \1\+\+\) \{", r"for \1 in range(\2):"),
            (r"for \(int (\w+) = (\d+); \1 < (\d+); \1\+\+\) \{", r"for \1 in range(\2, \3):"),
            (r"while \((.+?)\) \{", r"while \1:"),
            (r"if \((.+?)\) \{", r"if \1:"),
            (r"\} else if \((.+?)\) \{", r"elif \1:"),
            (r"\} else \{", r"else:"),
        ]
    
    def convert_python_to_cpp(self, code):
        lines = code.strip().split('\n')
        result_lines = []
        
        for line in lines:
            line = line.rstrip()
            converted = False
            
            for pattern, replacement in self.python_to_cpp:
                if re.match(pattern, line):
                    result_lines.append(re.sub(pattern, replacement, line))
                    converted = True
                    break
            
            if not converted:
                result_lines.append(line)
        
        result = '\n'.join(result_lines)
        if 'cout' in result and '#include' not in result:
            result = '#include <iostream>\nusing namespace std;\n\nint main() {\n' + \
                    '\n'.join(f'    {line}' for line in result_lines) + '\n    return 0;\n}'
        
        return result
    
    def convert_cpp_to_python(self, code):
        code = re.sub(r'#include <.*?>', '', code)
        code = re.sub(r'using namespace.*?;', '', code)
        code = re.sub(r'int main\(\) \{', '', code)
        code = re.sub(r'\s*return 0;\s*\}', '', code)
        code = re.sub(r'^\s*\}\s*$', '', code, flags=re.MULTILINE)
        
        lines = code.strip().split('\n')
        result_lines = []
        
        for line in lines:
            line = line.strip()
            if not line:
                continue
                
            line = re.sub(r'^\s*', '', line)
            converted = False
            
            for pattern, replacement in self.cpp_to_python:
                if re.match(pattern, line):
                    result_lines.append(re.sub(pattern, replacement, line))
                    converted = True
                    break
            
            if not converted:
                result_lines.append(line)
        
        return '\n'.join(result_lines)

def main():
    if len(sys.argv) != 4:
        print(json.dumps({
            'success': False,
            'error': 'Usage: script.py <code> <source_lang> <target_lang>'
        }))
        sys.exit(1)
    
    code = sys.argv[1]
    source_lang = sys.argv[2]
    target_lang = sys.argv[3]
    
    converter = RuleBasedConverter()
    
    try:
        if source_lang == 'python' and target_lang == 'cpp':
            result = converter.convert_python_to_cpp(code)
            provider = 'Custom Rule-Based Python→C++ Converter'
        elif source_lang == 'cpp' and target_lang == 'python':
            result = converter.convert_cpp_to_python(code)
            provider = 'Custom Rule-Based C++→Python Converter'
        else:
            print(json.dumps({
                'success': False,
                'error': 'Only Python↔C++ conversion supported'
            }))
            sys.exit(1)
        
        print(json.dumps({
            'success': True,
            'convertedCode': result,
            'provider': provider
        }))
        
    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': str(e)
        }))
        sys.exit(1)

if __name__ == "__main__":
    main()
