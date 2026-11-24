param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArguments)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$GitHistoryRoot = Join-Path $Root '可清理数据\Git历史\.git'

if (!(Test-Path -LiteralPath (Join-Path $GitHistoryRoot 'HEAD') -PathType Leaf)) {
    [Console]::Error.WriteLine('未找到本地 Git 历史。检查“可清理数据\Git历史”，或从远端重新克隆。')
    exit 2
}
if (!$GitArguments -or $GitArguments.Count -eq 0) {
    [Console]::Error.WriteLine('用法：scripts\git-workspace.ps1 <Git 命令和参数>')
    exit 2
}

& git "--git-dir=$GitHistoryRoot" "--work-tree=$Root" @GitArguments
exit $LASTEXITCODE
