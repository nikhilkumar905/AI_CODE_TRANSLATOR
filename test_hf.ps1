$body = @{
    code = "def add(a, b): return a + b"
    sourceLanguage = "python"
    targetLanguage = "cpp"
} | ConvertTo-Json

Write-Host "Testing Python -> C++ conversion with Hugging Face..."
$result = irm http://localhost:6001/api/convert -Method POST -ContentType "application/json" -Body $body
Write-Host "Provider:" $result.provider
Write-Host "Output:" $result.convertedCode
Write-Host ""

$body2 = @{
    code = "int add(int a, int b) { return a + b; }"
    sourceLanguage = "cpp"
    targetLanguage = "python"
} | ConvertTo-Json

Write-Host "Testing C++ -> Python conversion with Hugging Face..."
$result2 = irm http://localhost:6001/api/convert -Method POST -ContentType "application/json" -Body $body2
Write-Host "Provider:" $result2.provider
Write-Host "Output:" $result2.convertedCode
