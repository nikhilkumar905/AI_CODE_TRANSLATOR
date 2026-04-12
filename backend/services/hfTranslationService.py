"""
Hugging Face Translation Service
Uses pretrained CodeT5 model for Python↔C++ translation
"""

import torch
from transformers import AutoTokenizer, AutoModelForSeq2SeqLM
import json
import sys
import os

class HFTranslationService:
    def __init__(self, model_name="microsoft/unixcoder-base-nine"):
        self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        print(f"Loading Hugging Face model: {model_name} on {self.device}", file=sys.stderr)
        
        try:
            # Load tokenizer and model with timeout handling
            self.tokenizer = AutoTokenizer.from_pretrained(
                model_name,
                local_files_only=False,
                resume_download=True
            )
            self.model = AutoModelForSeq2SeqLM.from_pretrained(
                model_name,
                local_files_only=False,
                resume_download=True
            )
            self.model.to(self.device)
            self.model.eval()
            
            print(f"Hugging Face model loaded successfully", file=sys.stderr)
            
        except Exception as e:
            print(json.dumps({'success': False, 'error': f'Failed to load model: {str(e)}'}), flush=True)
            sys.exit(1)
    
    def translate(self, code, source_lang, target_lang):
        """Translate code using pretrained HF model"""
        try:
            # Prepare input with clear instruction
            prefix = f"Convert this {source_lang} code to {target_lang}: "
            input_text = f"{prefix}{code}"
            
            # Tokenize
            inputs = self.tokenizer.encode_plus(
                input_text,
                return_tensors='pt',
                max_length=512,
                truncation=True,
                padding='max_length'
            ).to(self.device)
            
            # Generate translation with improved parameters
            with torch.no_grad():
                outputs = self.model.generate(
                    inputs['input_ids'],
                    attention_mask=inputs['attention_mask'],
                    max_length=256,
                    min_length=10,
                    num_beams=5,
                    num_return_sequences=1,
                    early_stopping=True,
                    no_repeat_ngram_size=3,
                    repetition_penalty=2.0,
                    length_penalty=1.0,
                    temperature=0.7,
                    top_k=50,
                    top_p=0.95,
                    do_sample=True,
                    bad_words_ids=[[self.tokenizer.encode('<pad>')[0]]]
                )
            
            # Decode output
            translated = self.tokenizer.decode(outputs[0], skip_special_tokens=True)
            
            # Clean up the output
            translated = self.clean_output(translated, source_lang, target_lang)
            
            # If cleaning returned None (detected failure), return error
            if translated is None:
                return {
                    'success': False,
                    'error': 'Model produced invalid output'
                }
            
            return {
                'success': True,
                'convertedCode': translated,
                'provider': f'Hugging Face ({self.model.config._name_or_path})'
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': f'Translation failed: {str(e)}'
            }
    
    def clean_output(self, text, source_lang, target_lang):
        """Clean and format the generated code"""
        import re
        
        # Remove common artifacts
        text = re.sub(r'\s+', ' ', text)  # Multiple spaces to single
        text = re.sub(r'\n\s*\n', '\n', text)  # Multiple empty lines
        
        # Check for severe repetition (indicates model failure)
        words = text.split()
        if len(words) > 20:
            word_counts = {}
            for word in words:
                word_counts[word] = word_counts.get(word, 0) + 1
            
            # If any word appears more than 10 times, return None to trigger fallback
            max_count = max(word_counts.values())
            if max_count > 10:
                return None
        
        # Remove repetitive patterns (common issue with CodeT5)
        cleaned_words = []
        prev_word = None
        repeat_count = 0
        
        for word in words:
            if word == prev_word:
                repeat_count += 1
                if repeat_count < 2:  # Allow max 1 repetition
                    cleaned_words.append(word)
            else:
                repeat_count = 0
                cleaned_words.append(word)
            prev_word = word
        
        text = ' '.join(cleaned_words)
        
        # Remove incomplete fragments
        text = text.strip()
        if text.endswith(':') or text.endswith('=') or text.endswith('('):
            text = text[:-1].strip()
        
        # Ensure proper code structure
        if target_lang.lower() == 'cpp':
            # Basic C++ formatting
            text = re.sub(r'int\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*', r'int \1 = ', text)
            text = re.sub(r'void\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(', r'void \1(', text)
        elif target_lang.lower() == 'python':
            # Basic Python formatting
            text = re.sub(r'def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(', r'def \1(', text)
            text = re.sub(r'for\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+', r'for \1 in ', text)
        
        return text

def main():
    if len(sys.argv) != 4:
        print(json.dumps({
            'success': False,
            'error': 'Usage: hf_service.py <code> <source_lang> <target_lang>'
        }))
        sys.exit(1)
    
    code = sys.argv[1]
    source_lang = sys.argv[2]
    target_lang = sys.argv[3]
    
    service = HFTranslationService()
    result = service.translate(code, source_lang, target_lang)
    
    print(json.dumps(result), flush=True)

if __name__ == "__main__":
    main()
